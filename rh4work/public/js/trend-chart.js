// trend-chart.js — renders a small blue line chart into any container.
// points: [{ label: 'D1', value: 0..100, tooltip: 'optional' }, ...]
window.renderTrendChart = function (container, points, opts) {
  opts = opts || {};
  const max = opts.max || 100;
  if (!points || points.length < 2) {
    container.innerHTML = '<div class="trend-empty">' + (opts.emptyText || 'Not enough data yet — complete a couple more days to see a trend.') + '</div>';
    return;
  }
  const W = 720, H = 160, pad = 26;
  const n = points.length;
  const xFor = (i) => pad + (i / (n - 1)) * (W - pad * 2);
  const yFor = (v) => H - pad - (v / max) * (H - pad * 2);

  let svg = '';
  [0, 0.5, 1].forEach((frac) => {
    const y = H - pad - frac * (H - pad * 2);
    svg += '<line class="trend-grid" x1="' + pad + '" y1="' + y + '" x2="' + (W - pad) + '" y2="' + y + '"></line>';
    svg += '<text class="trend-label" x="' + (pad - 6) + '" y="' + (y + 3) + '" text-anchor="end">' + Math.round(frac * max) + '</text>';
  });

  const pts = points.map((p, i) => ({ x: xFor(i), y: yFor(p.value), label: p.label }));
  const d = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ' ' + p.y.toFixed(1)).join(' ');
  svg += '<path class="trend-line" d="' + d + '"></path>';
  pts.forEach((p) => {
    svg += '<circle class="trend-dot" cx="' + p.x + '" cy="' + p.y + '" r="3.5"><title>' + p.label + '</title></circle>';
    svg += '<text class="trend-label" x="' + p.x + '" y="' + (H - 6) + '" text-anchor="middle">' + p.label + '</text>';
  });

  container.innerHTML = '<svg class="trend-svg" viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '">' + svg + '</svg>';
};
