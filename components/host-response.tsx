import { ChevronDown, LockKeyhole } from 'lucide-react';

/** Host-only presentation; callers retain the existing server-authorized role gate. */
export default function HostResponse({
  response,
  notes,
  title = 'Private correct response',
}: {
  response?: string;
  notes?: string;
  title?: string;
}) {
  return (
    <details className="host-answer review-disclosure">
      <summary>
        <span className="disclosure-icon">
          <LockKeyhole size={19} aria-hidden="true" />
        </span>
        <strong>{title}</strong>
        <span className="disclosure-tag" aria-hidden="true">
          Host only
        </span>
        <ChevronDown className="disclosure-chevron" size={19} aria-hidden="true" />
      </summary>
      <div className="host-response-content">
        <p className="host-response-text">{response}</p>
        {notes?.trim() && (
          <div className="host-response-notes">
            <span className="response-caption">Acceptable responses / host notes</span>
            <p>{notes}</p>
          </div>
        )}
      </div>
    </details>
  );
}
