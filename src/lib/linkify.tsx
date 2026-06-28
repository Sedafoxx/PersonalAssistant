import { Fragment, type ReactNode } from "react";

// Matches http(s) URLs and bare www. links.
const URL_RE = /\b((?:https?:\/\/|www\.)[^\s<]+[^\s<.,:;!?)\]}'"])/gi;

// Turn plain text into nodes where URLs become clickable anchors.
// Used in the read-only item detail view so hyperlinks captured in notes are
// actually reachable (you can't click a link inside a textarea).
export function linkify(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  URL_RE.lastIndex = 0;
  let key = 0;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(<Fragment key={key++}>{text.slice(last, m.index)}</Fragment>);
    const raw = m[0];
    const href = raw.startsWith("http") ? raw : `https://${raw}`;
    out.push(
      <a
        key={key++}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-indigo-400 underline underline-offset-2 hover:text-indigo-300 break-all"
      >
        {raw}
      </a>
    );
    last = m.index + raw.length;
  }
  if (last < text.length) out.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return out;
}
