export function AquaGreenLogo({ className = '', white = false }: { className?: string; white?: boolean }) {
  const textFill = white ? '#fff' : '#1B5E20'
  const leafFill = white ? '#81C784' : '#4CAF50'
  const taglineFill = white ? 'rgba(255,255,255,0.6)' : '#888'

  return (
    <svg viewBox="0 0 320 70" className={className} xmlns="http://www.w3.org/2000/svg">
      {/* AQUA */}
      <text x="0" y="42" fontFamily="'Arial Black', 'Helvetica', sans-serif" fontWeight="900" fontSize="38" fill={textFill} letterSpacing="2">
        AQUA
      </text>
      {/* Leaf replacing O */}
      <g transform="translate(138, 10)">
        <path d="M18 2 C18 2, 30 8, 30 22 C30 36, 18 42, 18 42 C18 42, 6 36, 6 22 C6 8, 18 2, 18 2Z"
          fill={leafFill} opacity="0.9" />
        <line x1="18" y1="8" x2="18" y2="38" stroke={white ? '#fff' : '#1B5E20'} strokeWidth="1.5" opacity="0.5" />
        <path d="M18 16 C14 20, 12 24, 10 28" stroke={white ? '#fff' : '#1B5E20'} strokeWidth="1" fill="none" opacity="0.4" />
        <path d="M18 20 C22 24, 24 28, 26 32" stroke={white ? '#fff' : '#1B5E20'} strokeWidth="1" fill="none" opacity="0.4" />
      </g>
      {/* GREEN */}
      <text x="172" y="42" fontFamily="'Arial Black', 'Helvetica', sans-serif" fontWeight="900" fontSize="38" fill={textFill} letterSpacing="2">
        GREEN
      </text>
      {/* Tagline */}
      <text x="68" y="62" fontFamily="'Georgia', serif" fontSize="12" fill={taglineFill} fontStyle="italic" letterSpacing="1">
        From Seed To Table
      </text>
    </svg>
  )
}
