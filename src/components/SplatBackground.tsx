'use client';

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useRef } from 'react';

const LIGHT_COLOR_PALETTE = [
  '#f8c4d9', '#f2c3af', '#ffeab7',
  '#ecf3b7', '#cef3ff', '#eee3ff',
  '#c0d8f9', '#98f8e9',
];

const DARK_COLOR_PALETTE = [
  '#6b1f43', '#6a2f1a', '#6a5314',
  '#44580f', '#14415a', '#31185f',
  '#1d2f64', '#0e5748',
];

const SPLAT_COUNT = 12;

const THEME = {
  light: { bg: '#f8fafc', blendMode: 'multiply' as GlobalCompositeOperation, gradientEnd: 'rgba(255,255,255,0)' },
  dark:  { bg: '#050810', blendMode: 'screen'   as GlobalCompositeOperation, gradientEnd: 'rgba(0,0,0,0)' },
};

const VISIBLE_ROUTES = new Set(['/']);

interface SplatState {
  x: number;
  y: number;
  radius: number;
  lightColor: string;
  darkColor: string;
  vx: number;
  vy: number;
  pulseSpeed: number;
  pulseAmount: number;
}

function createSplat(width: number, height: number): SplatState {
  return {
    x: Math.random() * width,
    y: Math.random() * height,
    radius: Math.random() * 450 + 450,
    lightColor: LIGHT_COLOR_PALETTE[Math.floor(Math.random() * LIGHT_COLOR_PALETTE.length)],
    darkColor: DARK_COLOR_PALETTE[Math.floor(Math.random() * DARK_COLOR_PALETTE.length)],
    vx: (Math.random() - 0.5) * 2.2,
    vy: (Math.random() - 0.5) * 2.2,
    pulseSpeed: Math.random() * 0.016,
    pulseAmount: Math.random() * Math.PI * 2,
  };
}

function updateSplat(s: SplatState, width: number, height: number) {
  s.x += s.vx;
  s.y += s.vy;
  if (s.x < -s.radius / 2 || s.x > width + s.radius / 2) s.vx *= -1;
  if (s.y < -s.radius / 2 || s.y > height + s.radius / 2) s.vy *= -1;
  s.pulseAmount += s.pulseSpeed;
}

function drawSplat(ctx: CanvasRenderingContext2D, s: SplatState, color: string, gradientEnd: string) {
  const currentRadius = s.radius + Math.sin(s.pulseAmount) * 80;
  const gradient = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, currentRadius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(1, gradientEnd);
  ctx.beginPath();
  ctx.fillStyle = gradient;
  ctx.arc(s.x, s.y, currentRadius, 0, Math.PI * 2);
  ctx.fill();
}

function isDarkActive() {
  return document.documentElement.classList.contains('dark');
}

export default function SplatBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pathname = usePathname();
  const visible = VISIBLE_ROUTES.has(pathname);

  const darkRef = useRef(false);
  const splatsRef = useRef<SplatState[]>([]);
  const animIdRef = useRef<number>(0);

  const resize = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    if (splatsRef.current.length === 0) {
      for (let i = 0; i < SPLAT_COUNT; i++) {
        splatsRef.current.push(createSplat(canvas.width, canvas.height));
      }
    }
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    darkRef.current = isDarkActive();

    const observer = new MutationObserver(() => {
      darkRef.current = isDarkActive();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });

    function animate() {
      const w = canvas!.width;
      const h = canvas!.height;
      const t = darkRef.current ? THEME.dark : THEME.light;

      ctx!.globalCompositeOperation = 'source-over';
      ctx!.fillStyle = t.bg;
      ctx!.fillRect(0, 0, w, h);

      ctx!.globalCompositeOperation = t.blendMode;
      for (const splat of splatsRef.current) {
        updateSplat(splat, w, h);
        const color = darkRef.current ? splat.darkColor : splat.lightColor;
        drawSplat(ctx!, splat, color, t.gradientEnd);
      }

      animIdRef.current = requestAnimationFrame(animate);
    }

    resize();
    animate();
    window.addEventListener('resize', resize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      cancelAnimationFrame(animIdRef.current);
    };
  }, [resize]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0"
      style={{
        filter: 'blur(140px)',
        transform: 'scale(1.1)',
        opacity: visible ? 1 : 0,
        transition: 'opacity 600ms ease-in-out',
      }}
    />
  );
}
