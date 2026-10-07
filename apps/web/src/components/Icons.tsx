import type { ReactNode, SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

function Icon({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {children}
    </svg>
  )
}

export const MonitorIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 21h8M12 16v5" /></Icon>
export const LinkIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="14" width="7" height="5" rx="1" /><rect x="14" y="5" width="7" height="5" rx="1" /><path d="M10 16h2a4 4 0 0 0 4-4v-2M8 12v-2a4 4 0 0 1 4-4h2" /></Icon>
export const RefreshIcon = (props: IconProps) => <Icon {...props}><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 9a7 7 0 0 1 11.5-2L20 12M4 12l2.4 5a7 7 0 0 0 11.5-2" /></Icon>
export const CopyIcon = (props: IconProps) => <Icon {...props}><rect x="8" y="8" width="11" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h2" /></Icon>
export const LockIcon = (props: IconProps) => <Icon {...props}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><rect x="9" y="10" width="6" height="5" rx="1" /><path d="M10.5 10V8.5a1.5 1.5 0 0 1 3 0V10" /></Icon>
export const ClockIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Icon>
export const NetworkIcon = (props: IconProps) => <Icon {...props}><rect x="3" y="3" width="7" height="6" rx="1" /><rect x="14" y="15" width="7" height="6" rx="1" /><path d="M10 6h2a4 4 0 0 1 4 4v5M14 18h-2a4 4 0 0 1-4-4V9" /></Icon>
export const ArrowRightIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="m10 8 4 4-4 4" /></Icon>
export const SettingsIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1A1.7 1.7 0 0 0 9 4.6 1.7 1.7 0 0 0 10 3V2.8h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z" /></Icon>
export const InfoIcon = (props: IconProps) => <Icon {...props}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Icon>
export const XIcon = (props: IconProps) => <Icon {...props}><path d="m6 6 12 12M18 6 6 18" /></Icon>
export const MaximizeIcon = (props: IconProps) => <Icon {...props}><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" /></Icon>
