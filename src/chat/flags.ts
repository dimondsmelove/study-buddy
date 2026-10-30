// Inline SVG flags (viewBox 30x20). Flag emoji do not render on Windows and
// many Linux Chrome builds, so the language picker draws its own.
import type { AnswerLanguage } from '../shared/settings'

const h3 = (a: string, b: string, c: string) =>
  `<rect width="30" height="20" fill="${b}"/><rect width="30" height="6.67" fill="${a}"/><rect y="13.33" width="30" height="6.67" fill="${c}"/>`
const v3 = (a: string, b: string, c: string) =>
  `<rect width="10" height="20" fill="${a}"/><rect x="10" width="10" height="20" fill="${b}"/><rect x="20" width="10" height="20" fill="${c}"/>`
const nordic = (bg: string, cross: string, inner?: string) =>
  `<rect width="30" height="20" fill="${bg}"/><path d="M0 10h30M11 0v20" stroke="${cross}" stroke-width="${inner ? 5 : 3.4}"/>` +
  (inner ? `<path d="M0 10h30M11 0v20" stroke="${inner}" stroke-width="2.4"/>` : '')

const BODY: Record<AnswerLanguage, string> = {
  auto: `<rect width="30" height="20" rx="2" fill="#e8eef9"/><circle cx="15" cy="10" r="7" fill="none" stroke="#2563eb" stroke-width="1.4"/><path d="M8 10h14M15 3c-3 3.5-3 10.5 0 14M15 3c3 3.5 3 10.5 0 14" fill="none" stroke="#2563eb" stroke-width="1.2"/>`,
  en: `<rect width="30" height="20" fill="#012169"/><path d="M0 0l30 20M30 0L0 20" stroke="#fff" stroke-width="4"/><path d="M0 0l30 20M30 0L0 20" stroke="#C8102E" stroke-width="1.4"/><path d="M15 0v20M0 10h30" stroke="#fff" stroke-width="6"/><path d="M15 0v20M0 10h30" stroke="#C8102E" stroke-width="3.4"/>`,
  de: h3('#000', '#DD0000', '#FFCE00'),
  fr: v3('#0055A4', '#fff', '#EF4135'),
  es: `<rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/>`,
  it: v3('#009246', '#fff', '#CE2B37'),
  nl: h3('#AE1C28', '#fff', '#21468B'),
  sv: nordic('#006AA7', '#FECC00'),
  da: nordic('#C8102E', '#fff'),
  no: nordic('#BA0C2F', '#fff', '#00205B'),
  fi: nordic('#fff', '#002F6C'),
  ar: `<rect width="30" height="20" fill="#006C35"/><path d="M8 8.5h14M9 11.5h12" stroke="#fff" stroke-width="1.1"/><path d="M9 14.5h11" stroke="#fff" stroke-width="0.8"/>`,
  id: `<rect width="30" height="20" fill="#fff"/><rect width="30" height="10" fill="#CE1126"/>`,
  ru: h3('#fff', '#0039A6', '#D52B1E'),
  pt: `<rect width="30" height="20" fill="#009C3B"/><path d="M15 2.5L27 10 15 17.5 3 10z" fill="#FFDF00"/><circle cx="15" cy="10" r="4.4" fill="#002776"/><path d="M10.8 9.2c3-.7 6-.3 8.4 1.2" stroke="#fff" stroke-width=".8" fill="none"/>`,
  ja: `<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="6" fill="#BC002D"/>`,
  fil: `<rect width="30" height="10" fill="#0038A8"/><rect y="10" width="30" height="10" fill="#CE1126"/><path d="M0 0l15 10L0 20z" fill="#fff"/><circle cx="5" cy="10" r="2" fill="#FCD116"/>`,
  vi: `<rect width="30" height="20" fill="#DA251D"/><path d="M15 4l1.76 5.4h5.7l-4.6 3.35 1.76 5.4L15 14.8l-4.62 3.35 1.76-5.4-4.6-3.35h5.7z" fill="#FFFF00"/>`,
  tr: `<rect width="30" height="20" fill="#E30A17"/><circle cx="11" cy="10" r="5" fill="#fff"/><circle cx="12.3" cy="10" r="4" fill="#E30A17"/><path d="M17.2 10l3.9-1.3-2.4 3.3V8l2.4 3.3z" fill="#fff"/>`,
  th: `<rect width="30" height="20" fill="#A51931"/><rect y="3.33" width="30" height="13.33" fill="#F4F5F8"/><rect y="6.67" width="30" height="6.67" fill="#2D2A4A"/>`,
  ko: `<rect width="30" height="20" fill="#fff"/><circle cx="15" cy="10" r="5" fill="#CD2E3A"/><path d="M10 10a2.5 2.5 0 0 0 5 0a2.5 2.5 0 0 1 5 0a5 5 0 0 1-10 0z" fill="#0047A0"/><path d="M4.5 4.5l3 2.2M22.5 15.3l3-2.2M4.5 15.5l3-2.2M22.5 4.7l3 2.2" stroke="#000" stroke-width="1.6"/>`,
}

export function flagSvg(code: AnswerLanguage): string {
  return `<svg class="flag" viewBox="0 0 30 20" aria-hidden="true">${BODY[code]}</svg>`
}

export const SHORT_CODE = (code: AnswerLanguage): string => (code === 'auto' ? 'AUTO' : code.toUpperCase())
