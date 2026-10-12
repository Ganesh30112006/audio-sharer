import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export function InviteCard({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const link = `${window.location.origin}/room/${code}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (insecure context); the link stays visible.
    }
  };
  return (
    <section className="card" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite listeners</h2>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span
          className="mono"
          style={{ fontSize: '1.6rem', letterSpacing: '0.18em' }}
          aria-label={`Room code ${code.split('').join(' ')}`}
        >
          {code}
        </span>
        <button type="button" className="btn" onClick={copy}>
          {copied ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
      <p className="small muted" style={{ overflowWrap: 'anywhere' }}>
        {link}
      </p>
    </section>
  );
}
