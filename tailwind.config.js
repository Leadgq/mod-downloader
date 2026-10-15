/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        ink: '#050608',
        surface: '#0E1116',
        line: '#1C212B',
        mist: '#8B93A7',
        accent: '#3DDC97'
      },
      fontFamily: {
        sans: ['Sora', 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'monospace']
      }
    }
  },
  plugins: []
}
