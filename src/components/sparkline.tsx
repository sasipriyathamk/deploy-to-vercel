export function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const width = 76;
  const height = 28;
  const coords = points
    .map((value, index) => {
      const x = (index / (points.length - 1)) * (width - 4) + 2;
      const y = height - 3 - ((value - min) / span) * (height - 6);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const up = points[points.length - 1] >= points[0];
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true" className="shrink-0">
      <polyline fill="none" stroke={up ? "var(--gain)" : "var(--loss)"} strokeWidth="1.6" strokeLinejoin="round" points={coords} />
    </svg>
  );
}
