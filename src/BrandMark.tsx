// App brand mark: 5-node network in the Qortium hexagon. Single-color
// (currentColor) so it adapts to the theme; ring interiors use the page
// background to mask the lines crossing behind the nodes. Slightly bolder
// strokes than the published icon so it stays legible at header size.
export function BrandMark() {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 683 685"
      fill="none"
      stroke="currentColor"
      strokeLinejoin="miter"
      strokeMiterlimit={10}
      aria-hidden="true"
      focusable="false"
    >
      <polygon points="341,32 72,189 72,501 341,657 610,501 610,189" strokeWidth={14} />
      <g strokeWidth={18} strokeLinecap="round">
        <line x1={341} y1={120} x2={290} y2={355} />
        <line x1={341} y1={120} x2={392} y2={355} />
        <line x1={341} y1={120} x2={160} y2={490} />
        <line x1={341} y1={120} x2={522} y2={490} />
        <line x1={290} y1={355} x2={392} y2={355} />
        <line x1={290} y1={355} x2={160} y2={490} />
        <line x1={290} y1={355} x2={522} y2={490} />
        <line x1={392} y1={355} x2={160} y2={490} />
        <line x1={392} y1={355} x2={522} y2={490} />
        <line x1={160} y1={490} x2={522} y2={490} />
      </g>
      <g strokeWidth={17} fill="var(--qn-color-page-bg)">
        <circle cx={341} cy={120} r={36} />
        <circle cx={290} cy={355} r={36} />
        <circle cx={392} cy={355} r={36} />
        <circle cx={160} cy={490} r={36} />
        <circle cx={522} cy={490} r={36} />
      </g>
    </svg>
  );
}
