// @vitest-environment node
/**
 * The small chart spec compiled to Vega-Lite, then through Vega-Lite's own
 * compiler. Vega-Lite draws an empty chart for many mistakes instead of
 * failing, so the assertions that matter are that a valid small spec compiles
 * with no warnings, and that a broken one comes back as a readable error.
 */

import { parse, View } from 'vega';
import { compile } from 'vega-lite';
import { describe, expect, it } from 'vitest';

import { setFenceYamlValues } from '../../../core/fenceBody';
import { compileChart, compileChartSource } from '../chartSpec';
import { validateVegaLite } from '../vegaRender';

function compiled(source: string) {
  const result = compileChartSource(source);
  if (!result.ok) throw new Error(result.error);
  return result.spec as Record<string, any>;
}

/** The x axis's tick labels (the axis titled with the x field), as Vega draws them headlessly. */
async function xAxisLabels(spec: Record<string, any>): Promise<string[]> {
  const view = new View(parse(compile({ ...spec, width: 600 } as never).spec), { renderer: 'none' });
  await view.runAsync();
  const texts = (axis: any, role: string): string[] =>
    (axis.items ?? []).flatMap((group: any) => (group.items ?? []).filter((mark: any) => mark.role === role))
      .flatMap((mark: any) => (mark.items ?? []).map((item: any) => String(item.text)));
  const axes: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.marktype === 'group' && node.role === 'axis') axes.push(node);
    for (const item of node.items ?? []) walk(item);
  };
  walk((view.scenegraph() as any).root);
  view.finalize();
  const xAxis = axes.find((axis) => texts(axis, 'axis-title').includes(spec.encoding.x.field));
  return xAxis ? texts(xAxis, 'axis-label') : [];
}

const SERIES = `type: line
title: Sessions per week
x: week
y: [desktop, web]
data: |
  week,desktop,web
  2026-09-01,120,14
  2026-09-08,131,22`;

describe('compileChart', () => {
  it('folds a list of y columns into series with tooltips, hover and legend toggle', () => {
    const spec = compiled(SERIES);
    expect(spec.data.values).toEqual([
      { week: '2026-09-01', desktop: 120, web: 14 },
      { week: '2026-09-08', desktop: 131, web: 22 },
    ]);
    expect(spec.transform).toEqual([{ fold: ['desktop', 'web'], as: ['series', 'value'] }]);
    expect(spec.encoding.tooltip.map((t: { field: string }) => t.field)).toEqual(['week', 'series', 'value']);
    expect(spec.params.map((p: { name: string }) => p.name)).toEqual(['hover', 'legend']);
    expect(spec.params[1].bind).toBe('legend');

    const validation = validateVegaLite(spec);
    expect(validation.error).toBeUndefined();
    expect(validation.warnings).toEqual([]);
  });

  it('labels date-only x values once per row with month and day, in any time zone', async () => {
    const spec = compiled(`type: line
x: week
y: [fixed, smart]
data: |
  week,fixed,smart
  2026-08-31,212,208
  2026-09-07,219,251
  2026-09-14,224,288`);
    expect(await xAxisLabels(spec)).toEqual(['Aug 31', 'Sep 7', 'Sep 14']);
    expect(spec.params.some((p: { name: string }) => p.name === 'zoom')).toBe(false);
    expect(validateVegaLite(spec).warnings).toEqual([]);

    const months = compiled('type: bar\nx: month\ny: n\ndata: |\n  month,n\n  2025-12,4\n  2026-01,6');
    expect(await xAxisLabels(months)).toEqual(['Dec 2025', 'Jan 2026']);
  });

  it('keeps a zoomable time axis for timestamps', () => {
    const spec = compiled('type: line\nx: at\ny: n\ndata: |\n  at,n\n  2026-09-01T10:00,1\n  2026-09-01T11:30,2');
    expect(spec.encoding.x).toMatchObject({ field: 'at', type: 'temporal' });
    expect(spec.params.find((p: { name: string }) => p.name === 'zoom')).toMatchObject({ select: { type: 'interval', encodings: ['x'] }, bind: 'scales' });
  });

  it('compiles every type, from CSV or YAML rows, without Vega-Lite warnings', () => {
    const sources = [
      'type: bar\nx: week\ny: [desktop, web]\ndata: |\n  week,desktop,web\n  W36,120,14\n  W37,131,22',
      'type: area\nx: n\ny: v\ndata:\n  - {n: 1, v: 3}\n  - {n: 2, v: 5}',
      'type: scatter\nx: cost\ny: value\ndata: |\n  cost,value\n  1.5,3\n  2,"4"',
      'type: pie\nx: lane\ny: count\ndata: |\n  lane,count\n  "Team, shared",4\n  Personal,9',
    ];
    for (const source of sources) {
      const spec = compiled(source);
      const validation = validateVegaLite(spec);
      expect([validation.error, validation.warnings]).toEqual([undefined, []]);
    }
    const bar = compiled(sources[0]);
    // Grouped bars in data order, no zoom on a category axis.
    expect(bar.encoding.xOffset).toMatchObject({ field: 'series' });
    expect(bar.encoding.x.sort).toBeNull();
    expect(bar.params.some((p: { name: string }) => p.name === 'zoom')).toBe(false);
    const pie = compiled(sources[3]);
    expect(pie.data.values[0]).toEqual({ lane: 'Team, shared', count: 4 });
    expect(pie.encoding.theta.field).toBe('count');
    expect(pie.params.find((p: { name: string }) => p.name === 'legend').select.fields).toEqual(['lane']);
  });

  it('passes a raw vega-lite spec through, injecting the fence data only when the spec has none', () => {
    const raw = compiled(`title: Raw
vega-lite:
  mark: tick
  encoding:
    x: {field: a, type: quantitative}
data: |
  a
  1
  2`);
    expect(raw).toEqual({ mark: 'tick', encoding: { x: { field: 'a', type: 'quantitative' } }, data: { values: [{ a: 1 }, { a: 2 }] }, title: 'Raw' });

    const own = compiled(`vega-lite: '{"mark":"bar","data":{"values":[{"a":9}]}}'
data: |
  a
  1`);
    expect(own.data).toEqual({ values: [{ a: 9 }] });
  });

  it('rejects a raw spec that would fetch, link, show external images or bind outside the chart', () => {
    const vectors = [
      ['vega-lite:\n  data: {url: "https://evil.example/d.csv"}\n  mark: point', 'data must be inline'],
      ['vega-lite:\n  mark: point\n  transform:\n    - lookup: a\n      from: {data: {url: "x.csv"}, key: a, fields: [b]}', 'data must be inline'],
      ['vega-lite:\n  layer:\n    - mark: point\n      encoding: {href: {field: u}}', '"href"'],
      ['vega-lite:\n  mark: {type: point, href: "https://evil.example"}', '"href"'],
      ['vega-lite:\n  config: {mark: {href: "https://evil.example"}}\n  mark: point', '"href"'],
      ['vega-lite:\n  mark: {type: image}\n  encoding: {url: {field: u}}', 'image'],
      ['vega-lite:\n  mark: point\n  params: [{name: p, bind: {input: range, element: "#app"}}]', '"element"'],
    ] as const;
    for (const [source, message] of vectors) {
      const result = compileChartSource(`${source}\ndata: "u\\nx"`);
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.error, source).toContain(message);
    }
    // A data row may carry a column named url or href; only spec keys count.
    expect(compileChartSource('vega-lite:\n  mark: text\n  encoding: {text: {field: href}}\ndata: "href,url\\nhttps://a,https://b"').ok).toBe(true);
  });

  it('drops usermeta.embedOptions from a raw spec, keeping the rest of usermeta', () => {
    const spec = compiled('vega-lite:\n  mark: point\n  usermeta:\n    note: kept\n    embedOptions: {ast: false, config: "https://evil.example/c.json"}');
    expect(spec.usermeta).toEqual({ note: 'kept' });
  });

  it('titles axes and tooltips from fieldTitles, so internal column keys never show', () => {
    const result = compileChart(
      { type: 'bar', x: '@category', y: '@value', data: [{ '@category': 'Gold', '@value': 2 }] },
      { fieldTitles: { '@category': 'Tier', '@value': 'Count' } },
    );
    if (!result.ok) throw new Error(result.error);
    const encoding = result.spec.encoding as Record<string, any>;
    expect([encoding.x.title, encoding.y.title]).toEqual(['Tier', 'Count']);
    expect(encoding.tooltip.map((t: { title: string }) => t.title)).toEqual(['Tier', 'Count']);
  });

  it('returns a readable error for each kind of mistake', () => {
    const errors = [
      ['type: donut\nx: a\ny: b\ndata: "a,b\\n1,2"', '"type" must be one of'],
      ['type: bar\nx: a\ny: b', 'No data'],
      ['type: bar\nx: week\ny: [desktop, mobile]\ndata: |\n  week,desktop\n  W1,3', '"mobile" is not in the data (columns: week, desktop)'],
      ['type: line\nx: a\ny: b\ndata: |\n  a,b\n  1,high', '"b" must hold numbers'],
      ['type: pie\nx: a\ny: [b, c]\ndata: |\n  a,b,c\n  x,1,2', 'one "y" column'],
      ['type: bar\nx: [a\n', 'Not valid YAML'],
      ['vega-lite: "{not json"', 'not valid JSON'],
      ['data: 7\ntype: bar', '"data" must be CSV text'],
    ] as const;
    for (const [source, message] of errors) {
      const result = compileChartSource(source);
      expect(result.ok, source).toBe(false);
      if (!result.ok) expect(result.error).toContain(message);
    }
    // A raw spec Vega-Lite itself rejects is reported, not drawn empty.
    const invalid = compiled('vega-lite:\n  mark: nonsense\ndata: "a\\n1"');
    expect(validateVegaLite(invalid).error).toContain('Unknown mark "nonsense"');
    const badChannel = compiled('vega-lite:\n  mark: bar\n  encoding:\n    x: {field: a, type: wrong}\ndata: "a\\n1"');
    expect(validateVegaLite(badChannel).error).toContain('Invalid field type');
  });
});

describe('chart block size', () => {
  it('a drag rewrites only the top-level size lines, and the fence reads them back clamped', () => {
    const body = 'type: bar\nx: a\ny: b\ndata: |\n  a,b\n  width: 1\nvega-lite:\n  height: 90';
    const sized = setFenceYamlValues(body, { width: 480.4, height: 300 });
    // Added at the top, never inside the `data: |` text or the nested spec.
    expect(sized).toBe(`width: 480\nheight: 300\n${body}`);
    expect(compileChartSource(sized).size).toEqual({ width: 480, height: 300 });
    expect(setFenceYamlValues(sized, { width: 520, height: 260 })).toBe(`width: 520\nheight: 260\n${body}`);
    // Filling the column / resetting removes the lines.
    expect(setFenceYamlValues(sized, { width: null, height: null })).toBe(body);
    expect(compileChartSource('type: bar\nwidth: 10\nheight: 99999').size).toEqual({ width: 240, height: 1200 });
  });

  it('leaves a body it cannot edit line by line unchanged', () => {
    const flow = '{type: bar, x: a, y: b}';
    expect(setFenceYamlValues(flow, { width: 400, height: 200 })).toBe(flow);
  });
});
