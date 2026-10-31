/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        background: '#090d16',
        card: '#0f172a',
        border: '#1e293b',
        muted: '#64748b',
        primary: {
          DEFAULT: '#38bdf8',
          hover: '#0284c7',
        },
        danger: {
          DEFAULT: '#f43f5e',
          subtle: '#4c0519',
        },
        success: {
          DEFAULT: '#10b981',
          subtle: '#064e3b',
        },
      },
    },
  },
  plugins: [],
};

