// Inline stroke icons (no network fetch; the CSP only allows same-origin assets).
type IconProps = { className?: string };
const base = { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };

export const Logo = ({ className }: IconProps) => <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
  <defs><linearGradient id="rc-logo" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#5ef1ff" /><stop offset="1" stopColor="#8b7bff" /></linearGradient></defs>
  <rect x="2.5" y="4.5" width="27" height="19" rx="4" fill="none" stroke="url(#rc-logo)" strokeWidth="2" />
  <path d="M9 14h4l2-4 3 8 2-4h3" fill="none" stroke="url(#rc-logo)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  <path d="M12 28h8" stroke="url(#rc-logo)" strokeWidth="2" strokeLinecap="round" />
</svg>;
export const Monitor = ({ className }: IconProps) => <svg className={className} {...base}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></svg>;
export const Power = ({ className }: IconProps) => <svg className={className} {...base}><path d="M12 3v8" /><path d="M6.3 7.3a8 8 0 1 0 11.4 0" /></svg>;
export const Play = ({ className }: IconProps) => <svg className={className} {...base}><path d="M7 5l11 7-11 7z" /></svg>;
export const Expand = ({ className }: IconProps) => <svg className={className} {...base}><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>;
export const TextIcon = ({ className }: IconProps) => <svg className={className} {...base}><rect x="5" y="4" width="14" height="17" rx="2" /><path d="M9 4V3h6v1M9 10h6M9 14h4" /></svg>;
export const Keyboard = ({ className }: IconProps) => <svg className={className} {...base}><rect x="2.5" y="6" width="19" height="12" rx="2" /><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" /></svg>;
export const Sliders = ({ className }: IconProps) => <svg className={className} {...base}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>;
export const Dots = ({ className }: IconProps) => <svg className={className} {...base}><circle cx="5" cy="12" r="1.2" /><circle cx="12" cy="12" r="1.2" /><circle cx="19" cy="12" r="1.2" /></svg>;
export const Shield = ({ className }: IconProps) => <svg className={className} {...base}><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></svg>;
export const Arrow = ({ className }: IconProps) => <svg className={className} {...base}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
export const Chart = ({ className }: IconProps) => <svg className={className} {...base}><path d="M4 19h16" /><path d="M5 15l4-5 4 3 6-8" /></svg>;
export const LogOut = ({ className }: IconProps) => <svg className={className} {...base}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 16l-4-4 4-4M6 12h10" /></svg>;
