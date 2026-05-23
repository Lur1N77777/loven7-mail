import type { SVGProps } from 'react';

type BrandIconProps = SVGProps<SVGSVGElement> & {
  title?: string;
};

function SvgBase({ title, children, ...props }: BrandIconProps) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} {...props}>
      {title && <title>{title}</title>}
      {children}
    </svg>
  );
}

const strokeProps = {
  stroke: 'currentColor',
  strokeWidth: 2.15,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

function AccentDot({ cx, cy, r = 2.1 }: { cx: number; cy: number; r?: number }) {
  return <circle cx={cx} cy={cy} r={r} fill="var(--dashboard-icon-accent, currentColor)" />;
}

export function InboxLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M10.5 18.4 14.2 12h19.6l3.7 6.4v16.2a3.7 3.7 0 0 1-3.7 3.7H14.2a3.7 3.7 0 0 1-3.7-3.7V18.4Z" {...strokeProps} />
      <path d="M11.2 22.5h8.2c1.8 0 2.6 5.4 4.6 5.4s2.8-5.4 4.6-5.4h8.2" {...strokeProps} />
      <path d="M16.5 16.1h15" {...strokeProps} opacity=".54" />
      <AccentDot cx={34.4} cy={14.3} r={1.85} />
    </SvgBase>
  );
}

export function SentLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M10.7 25.2 38.4 11l-8.9 26.3-6.1-10.8-12.7-1.3Z" {...strokeProps} />
      <path d="M23.4 26.5 38.4 11" {...strokeProps} opacity=".62" />
      <path d="M16.5 33.6c2.8 1.8 6.4 2.6 10.6 2.3" {...strokeProps} opacity=".42" />
      <AccentDot cx={12.8} cy={14.9} r={1.75} />
    </SvgBase>
  );
}

export function AddressLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M15.2 13.2h17.6a4 4 0 0 1 4 4v17.6a4 4 0 0 1-4 4H15.2a4 4 0 0 1-4-4V17.2a4 4 0 0 1 4-4Z" {...strokeProps} />
      <path d="M17.2 22.5c2.8-3.6 7.4-4.3 10.6-1.8 3.9 3 1.7 9.4-2.7 8.5-2.3-.5-2.6-2.6-1.3-4.2 1.5-1.8 4.6-1.4 6.8 1.5" {...strokeProps} />
      <path d="M18.2 32.8h10.6" {...strokeProps} opacity=".48" />
      <AccentDot cx={33.8} cy={17.4} r={1.85} />
    </SvgBase>
  );
}

export function UsersLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M18.8 23.2a5.4 5.4 0 1 0 0-10.8 5.4 5.4 0 0 0 0 10.8Z" {...strokeProps} />
      <path d="M9.6 36.7c1.4-6 5-9 9.2-9s7.8 3 9.2 9" {...strokeProps} />
      <path d="M30.2 24.4a4.5 4.5 0 1 0-1.2-8.7" {...strokeProps} opacity=".58" />
      <path d="M28.8 29.2c4.2.4 7.2 2.9 8.6 7.2" {...strokeProps} opacity=".58" />
      <AccentDot cx={34.3} cy={13.5} r={1.75} />
    </SvgBase>
  );
}

export function UserAdminLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M21.2 23.1a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z" {...strokeProps} />
      <path d="M11.2 36.8c1.4-6.1 5.2-9.2 10-9.2 2.6 0 4.8.9 6.5 2.7" {...strokeProps} />
      <path d="M34.2 28.3v3.2l2.8 1.6" {...strokeProps} />
      <path d="M34.2 39.2a7.7 7.7 0 1 0 0-15.4 7.7 7.7 0 0 0 0 15.4Z" {...strokeProps} />
      <AccentDot cx={13.7} cy={15.2} r={1.55} />
    </SvgBase>
  );
}

export function ActivityLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M9.8 29.4h6.5l3.2-12.8 6.2 19.2 4.2-12.4h8.3" {...strokeProps} />
      <path d="M13.5 14.4c4.2-3.1 10.1-4 15.1-1.9 5.8 2.4 9.3 8 8.9 14.5" {...strokeProps} opacity=".42" />
      <path d="M13.1 36.2c3.5 2.2 8.1 2.9 12.4 1.8" {...strokeProps} opacity=".42" />
      <AccentDot cx={36.2} cy={15.5} r={1.75} />
    </SvgBase>
  );
}

export function TimeLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M24 39.2c8.4 0 15.2-6.8 15.2-15.2S32.4 8.8 24 8.8 8.8 15.6 8.8 24 15.6 39.2 24 39.2Z" {...strokeProps} />
      <path d="M24 15.6v9.1l6.1 3.6" {...strokeProps} />
      <path d="M15.2 10.4 11 14.5" {...strokeProps} opacity=".5" />
      <path d="M32.8 10.4 37 14.5" {...strokeProps} opacity=".5" />
      <AccentDot cx={24} cy={24} r={1.75} />
    </SvgBase>
  );
}

export function SettingsLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M24 29.4a5.4 5.4 0 1 0 0-10.8 5.4 5.4 0 0 0 0 10.8Z" {...strokeProps} />
      <path d="M35.7 24.9c.1-.6.1-1.2.1-1.8s0-1.2-.1-1.8l3-2.3-3-5.2-3.7 1.5a14.6 14.6 0 0 0-3.1-1.8L28.3 9h-6.1l-.6 4.5c-1.1.4-2.1 1-3.1 1.8l-3.7-1.5-3 5.2 3 2.3c-.1.6-.1 1.2-.1 1.8s0 1.2.1 1.8l-3 2.3 3 5.2 3.7-1.5c1 .8 2 1.4 3.1 1.8l.6 4.5h6.1l.6-4.5c1.1-.4 2.1-1 3.1-1.8l3.7 1.5 3-5.2-3-2.3Z" {...strokeProps} opacity=".82" />
    </SvgBase>
  );
}

export function WebhookLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M16.2 17.3a6.2 6.2 0 1 0 0 12.4" {...strokeProps} />
      <path d="M31.8 17.3a6.2 6.2 0 1 1 0 12.4" {...strokeProps} />
      <path d="M17.7 24h12.6" {...strokeProps} />
      <path d="M31.2 12.3c4.5 1.5 7.8 5.6 8 10.5" {...strokeProps} opacity=".45" />
      <path d="M16.8 35.7c-4.5-1.5-7.8-5.6-8-10.5" {...strokeProps} opacity=".45" />
      <AccentDot cx={24} cy={24} r={1.55} />
    </SvgBase>
  );
}

export function StorageLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M12 15.8c0-3 5.4-5.4 12-5.4s12 2.4 12 5.4-5.4 5.4-12 5.4-12-2.4-12-5.4Z" {...strokeProps} />
      <path d="M12 15.8v16.4c0 3 5.4 5.4 12 5.4s12-2.4 12-5.4V15.8" {...strokeProps} />
      <path d="M12 24c0 3 5.4 5.4 12 5.4s12-2.4 12-5.4" {...strokeProps} opacity=".52" />
      <AccentDot cx={31.8} cy={17.4} r={1.55} />
    </SvgBase>
  );
}

export function LockLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M15.2 21.4v-3.8c0-5 3.7-8.7 8.8-8.7s8.8 3.7 8.8 8.7v3.8" {...strokeProps} />
      <path d="M14 21.4h20a3.2 3.2 0 0 1 3.2 3.2v9.9a3.2 3.2 0 0 1-3.2 3.2H14a3.2 3.2 0 0 1-3.2-3.2v-9.9a3.2 3.2 0 0 1 3.2-3.2Z" {...strokeProps} />
      <path d="M24 28.4v3.7" {...strokeProps} />
      <AccentDot cx={24} cy={27.4} r={1.55} />
    </SvgBase>
  );
}

export function DeleteMailLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M13.2 17.5h21.6" {...strokeProps} />
      <path d="M19.2 17.5v-3.2h9.6v3.2" {...strokeProps} />
      <path d="M16.5 21.6 18 37.5h12l1.5-15.9" {...strokeProps} />
      <path d="M20.7 25.1h6.5" {...strokeProps} opacity=".5" />
      <AccentDot cx={33.8} cy={13.6} r={1.55} />
    </SvgBase>
  );
}

export function GateLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M12.2 38V14.5a3.4 3.4 0 0 1 3.4-3.4h16.8a3.4 3.4 0 0 1 3.4 3.4V38" {...strokeProps} />
      <path d="M18.2 38V16.7h11.6V38" {...strokeProps} />
      <path d="M28.4 27.4h.1" {...strokeProps} />
      <path d="M9.8 38h28.4" {...strokeProps} />
      <AccentDot cx={33.6} cy={14.8} r={1.55} />
    </SvgBase>
  );
}

export function AnonymousLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M12.5 25.6c2.5-3.8 6.3-5.7 11.5-5.7s9 1.9 11.5 5.7" {...strokeProps} />
      <path d="M15 26.2c.9 4.6 4.2 7.3 9 7.3s8.1-2.7 9-7.3" {...strokeProps} />
      <path d="M18.3 25.2h3.6" {...strokeProps} />
      <path d="M26.1 25.2h3.6" {...strokeProps} />
      <path d="M15.6 17.7c5.2-2.8 11.6-2.8 16.8 0" {...strokeProps} opacity=".5" />
      <AccentDot cx={36.2} cy={23.8} r={1.5} />
    </SvgBase>
  );
}

export function ChartLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M12 36.5h24" {...strokeProps} />
      <path d="M14.8 31.5V22" {...strokeProps} />
      <path d="M24 31.5V13.8" {...strokeProps} />
      <path d="M33.2 31.5V18.5" {...strokeProps} />
      <path d="M14.8 21.8 24 13.8l9.2 4.7" {...strokeProps} opacity=".58" />
      <AccentDot cx={24} cy={13.8} r={1.7} />
    </SvgBase>
  );
}

export function HeroOrbitLogo(props: BrandIconProps) {
  return (
    <SvgBase {...props}>
      <path d="M9.5 27.4c5.9-11.9 16.7-16.7 29-13-5.2 2.4-9.4 6.3-12.4 11.5 4.6-.8 8.9-.2 12.4 2-9.4.8-16 4.6-19.9 11.4-1.2-5-4.2-8.9-9.1-11.9Z" {...strokeProps} />
      <path d="M18 27.4c5.6-1.7 11.5-5 17.4-10" {...strokeProps} opacity=".62" />
      <path d="M12.7 15.1c2.3-2.4 5.2-3.9 8.6-4.4" {...strokeProps} opacity=".46" />
      <AccentDot cx={34.7} cy={28.1} r={2} />
    </SvgBase>
  );
}
