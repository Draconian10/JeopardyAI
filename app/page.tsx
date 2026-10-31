import Link from 'next/link';
import { ArrowRight, Monitor, Smartphone, Radio, Trophy, Sparkles } from 'lucide-react';
export default function Home() {
  return (
    <div className="home">
      <div className="eyebrow">
        <span className="live-dot" /> YOUR NEXT GAME NIGHT STARTS HERE
      </div>
      <h1>
        A board full of questions.
        <br />
        <span>A room full of contenders.</span>
      </h1>
      <p className="home-subtitle">
        Your categories. Your people. One very competitive buzzer.
        <br />
        Bring everyone together for a game night worth talking about.
      </p>
      <div className="entry-grid">
        <Link href="/host" className="entry-card host-card">
          <span className="card-icon">
            <Monitor size={29} />
          </span>
          <span className="tiny-label">YOU’RE RUNNING THE SHOW</span>
          <h2>Host a game</h2>
          <p>
            Build your board, gather your players,
            <br />
            and take the host’s seat.
          </p>
          <div className="entry-bottom">
            <span>Let’s set the stage</span>
            <ArrowRight size={22} />
          </div>
        </Link>
        <Link href="/join" className="entry-card join-card">
          <span className="card-icon">
            <Smartphone size={29} />
          </span>
          <span className="tiny-label">YOUR MOMENT TO SHINE</span>
          <h2>Join a game</h2>
          <p>
            Got a game code? Grab your phone.
            <br />
            Your buzzer is waiting.
          </p>
          <div className="entry-bottom">
            <span>I’m ready to play</span>
            <ArrowRight size={22} />
          </div>
        </Link>
      </div>
      <div className="home-features">
        <span>
          <Radio size={17} /> Live buzzers
        </span>
        <span>
          <Sparkles size={17} /> Custom boards
        </span>
        <span>
          <Trophy size={17} /> Big bragging rights
        </span>
      </div>
      <div className="mini-board" aria-hidden="true">
        {['HISTORY', 'SCIENCE', 'WILD CARD', 'THE ARTS', 'WORLD', 'SPORTS'].map((s, i) => (
          <div key={s}>
            <span>{s}</span>
            <b>${((i % 3) + 1) * 200}</b>
            <b>${((i % 3) + 2) * 200}</b>
          </div>
        ))}
      </div>
    </div>
  );
}
