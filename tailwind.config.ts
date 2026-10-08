import type { Config } from 'tailwindcss';

// The palette is a copy of Ritu Desk's design tokens (06a §1.2, §16: the UI kit starts as a
// copy owned by this repo). THE PALETTE IS OVERRIDDEN, NOT EXTENDED: only these tokens
// compile, so the app cannot drift into Tailwind's default colours. The class lint and the
// rest of the kit arrive in PR 4. Fonts are the system stack (no build-time font download).
const config: Config = {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}', './lib/**/*.{ts,tsx}'],
  theme: {
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      white: '#FFFFFF',
      black: '#000000',
      canvas: '#F5F3EE',
      surface: { DEFAULT: '#FFFFFF', raise: '#EFECE4', sunk: '#EFECE4' },
      hairline: { DEFAULT: '#E7E2D6', firm: '#CFC9BB' },
      ink: { DEFAULT: '#0B0B0C', soft: '#3A3A40' },
      muted: '#6B6B70',
      faint: { DEFAULT: '#76767C', line: '#9A9A9E' },
      brand: { DEFAULT: '#3949E6', hover: '#2A37C2', tint: '#EEF0FE', peri: '#6675FF' },
      ok: { DEFAULT: '#16A34A', wash: '#E6F5EB', ink: '#14532D' },
      warn: { DEFAULT: '#D97706', wash: '#FBF0DC', ink: '#7C3E00' },
      bad: { DEFAULT: '#DC2626', wash: '#FBE5E5', ink: '#7F1D1D' },
    },
    extend: {
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Noto Sans', 'Noto Sans Gujarati', 'Noto Sans Devanagari', 'sans-serif'],
      },
      fontSize: {
        h1: ['30px', { lineHeight: '1.12', letterSpacing: '-0.02em', fontWeight: '800' }],
        h2: ['22px', { lineHeight: '1.25', letterSpacing: '-0.015em', fontWeight: '700' }],
        body: ['16px', { lineHeight: '1.6' }],
        small: ['14px', { lineHeight: '1.5' }],
        micro: ['12px', { lineHeight: '1.45' }],
      },
      boxShadow: {
        card: '0 1px 2px rgba(11,11,12,0.04), 0 6px 20px rgba(11,11,12,0.06)',
        brutal: '4px 4px 0 0 #0B0B0C',
        'brutal-sm': '2px 2px 0 0 #0B0B0C',
      },
      borderRadius: { xl2: '14px' },
      minHeight: { tap: '44px', 'tap-lg': '48px' },
    },
  },
  plugins: [],
};

export default config;
