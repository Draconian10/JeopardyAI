'use client';
import { useEffect, useRef, useState } from 'react';

const DURATION = 3400;
const COLORS = ['#edbd60', '#c59bea', '#78519f', '#f3d89a', '#52346f'];
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  rotation: number;
  spin: number;
  width: number;
  height: number;
  phase: number;
  round: boolean;
}
/** A short, silent two-cannon burst; never blocks results controls or changes scores. */
export default function ResultsConfetti({ sessionId }: { sessionId: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const key = `jeopardy:results-confetti:${sessionId}`;
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, 'played');
    } catch {
      /* Storage may be disabled; still allow this one mounted burst. */
    }
    setActive(true);
  }, [sessionId]);
  useEffect(() => {
    if (!active) return;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      setActive(false);
      return;
    }
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (media.matches) {
      setActive(false);
      return;
    }
    let width = window.innerWidth,
      height = window.innerHeight;
    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };
    resize();
    // Seed by match so palette and launch shape are consistent across renders.
    let seed = Array.from(sessionId).reduce(
      (sum, c) => (Math.imul(sum, 31) + c.charCodeAt(0)) | 0,
      1,
    );
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
      return (seed >>> 0) / 4294967296;
    };
    const count = width < 600 ? 90 : 140;
    const particles: Particle[] = Array.from({ length: count }, (_, i) => {
      const side = i % 2 === 0 ? 1 : -1;
      return {
        x: width * (side === 1 ? 0.08 : 0.92),
        y: height * 0.82,
        vx: side * width * (0.22 + random() * 0.35),
        vy: -height * (0.7 + random() * 0.45),
        rotation: random() * Math.PI,
        spin: (random() - 0.5) * 12,
        width: 4 + random() * 5,
        height: 5 + random() * 8,
        phase: random() * Math.PI * 2,
        round: i % 9 === 0,
      };
    });
    let frame = 0,
      started: number | undefined,
      previous = 0;
    const draw = (now: number) => {
      if (started === undefined) {
        started = now;
        previous = now;
      }
      const elapsed = now - started,
        dt = Math.min((now - previous) / 1000, 0.035);
      previous = now;
      ctx.clearRect(0, 0, width, height);
      if (elapsed >= DURATION) {
        setActive(false);
        return;
      }
      const opacity = Math.min(1, (DURATION - elapsed) / 850);
      particles.forEach((p, i) => {
        p.vx *= Math.pow(0.985, dt * 60);
        p.vy += height * 0.95 * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rotation += p.spin * dt;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rotation);
        ctx.scale(1, Math.max(0.16, Math.abs(Math.cos(elapsed * 0.004 + p.phase))));
        ctx.globalAlpha = opacity * 0.92;
        ctx.fillStyle = COLORS[i % COLORS.length];
        if (p.round) {
          ctx.beginPath();
          ctx.arc(0, 0, p.width * 0.4, 0, Math.PI * 2);
          ctx.fill();
        } else ctx.fillRect(-p.width / 2, -p.height / 2, p.width, p.height);
        ctx.restore();
      });
      frame = requestAnimationFrame(draw);
    };
    const reduce = () => {
      if (media.matches) setActive(false);
    };
    window.addEventListener('resize', resize);
    media.addEventListener('change', reduce);
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      media.removeEventListener('change', reduce);
      ctx.clearRect(0, 0, width, height);
    };
  }, [active, sessionId]);
  return active ? (
    <canvas
      ref={canvasRef}
      className="results-confetti"
      data-testid="results-confetti"
      aria-hidden="true"
    />
  ) : null;
}
