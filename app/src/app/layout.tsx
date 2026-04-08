import type { Metadata } from 'next'
import './globals.css'
export const metadata: Metadata = { title: 'Tunedex', description: 'Real-time music artist heat scores' }
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (<html lang="en"><body className="bg-black text-white min-h-screen">{children}</body></html>)
}