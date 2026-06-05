// ShowRunr brand logo. Source artwork: brand-identity/showrunner-logo.svg.
// LogoMark = the "Signal Grid" mark only (for compact placements like the nav bar).
// LogoFull = the full lockup with wordmark + patch-cable (for the sign-in screen).

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 152"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="ShowRunr"
      className={className}
    >
      {/* Row 1 (Upstage) */}
      <rect x="0" y="0" width="64" height="64" rx="8" fill="#333333" />
      <rect x="88" y="0" width="64" height="64" rx="8" fill="#333333" />
      <rect x="176" y="0" width="64" height="64" rx="8" fill="#333333" />
      {/* Row 2 (Downstage) — the "Lead" in Signal Green */}
      <rect x="0" y="88" width="64" height="64" rx="8" fill="#333333" />
      <rect x="88" y="88" width="64" height="64" rx="8" fill="#39FF14" />
      <rect x="176" y="88" width="64" height="64" rx="8" fill="#333333" />
    </svg>
  );
}

export function LogoFull({ className }: { className?: string }) {
  return (
    <svg
      width="512"
      height="512"
      viewBox="0 0 512 512"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="ShowRunr"
      className={className}
    >
      <rect width="512" height="512" rx="112" fill="#121212" />
      <g transform="translate(136, 120)">
        <rect x="0" y="0" width="64" height="64" rx="8" fill="#333333" />
        <rect x="88" y="0" width="64" height="64" rx="8" fill="#333333" />
        <rect x="176" y="0" width="64" height="64" rx="8" fill="#333333" />
        <rect x="0" y="88" width="64" height="64" rx="8" fill="#333333" />
        <rect x="88" y="88" width="64" height="64" rx="8" fill="#39FF14" />
        <rect x="176" y="88" width="64" height="64" rx="8" fill="#333333" />
      </g>
      <text
        x="50%"
        y="380"
        dominantBaseline="middle"
        textAnchor="middle"
        fontFamily="Inter, system-ui, -apple-system, sans-serif"
        fontWeight="800"
        fontSize="64"
        fill="white"
      >
        ShowRun<tspan fill="#39FF14">r</tspan>
      </text>
      <path
        d="M120 440H400C415 440 422 432 422 418V405"
        stroke="#39FF14"
        strokeWidth="10"
        strokeLinecap="round"
        fill="none"
      />
      <rect x="415" y="395" width="14" height="4" rx="2" fill="#39FF14" />
    </svg>
  );
}
