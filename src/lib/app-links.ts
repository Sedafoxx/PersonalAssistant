// Open a link in the app that OWNS it, rather than in the browser.
//
// A plain https link to youtube.com opens the browser, which is right on a desktop
// and wrong on a phone: the YouTube app is where the video actually plays, with the
// account, the history and no ad-blocking fights. Android lets a page say so
// explicitly with an `intent://` URL that names the target package and carries a
// browser fallback, so a device WITHOUT the app still lands somewhere sensible.
//
// ANDROID ONLY, deliberately. iOS already does this from an https link via
// Universal Links, so rewriting the URL there would risk a dead link when the app
// is absent and gain nothing when it is present. Desktop gets the plain URL for the
// same reason.

/** YouTube in any of its shapes: /watch?v=, /shorts/, /embed/, /live/, youtu.be. */
const YOUTUBE =
  /(?:youtube\.com\/(?:watch\?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/;

/** Spotify's own link shape: open.spotify.com/<kind>/<id>. */
const SPOTIFY = /open\.spotify\.com\/(episode|show|track|album|playlist)\/([A-Za-z0-9]+)/;

const YOUTUBE_PACKAGE = "com.google.android.youtube";
const SPOTIFY_PACKAGE = "com.spotify.music";

/**
 * The `intent://` URL for a link, or null when the link is not one we can hand to
 * an app. Pure and dependency-free so it can be reasoned about (and tested)
 * without a browser.
 */
export function androidIntentFor(url: string): string | null {
  const yt = url.match(YOUTUBE);
  if (yt) {
    const id = yt[1];
    // Always land on the canonical watch URL, so a /shorts/ or youtu.be link
    // behaves the same once it reaches the app.
    const watch = `https://www.youtube.com/watch?v=${id}`;
    return (
      `intent://www.youtube.com/watch?v=${id}` +
      `#Intent;package=${YOUTUBE_PACKAGE};scheme=https` +
      `;S.browser_fallback_url=${encodeURIComponent(watch)};end`
    );
  }

  const sp = url.match(SPOTIFY);
  if (sp) {
    const target = `open.spotify.com/${sp[1]}/${sp[2]}`;
    return (
      `intent://${target}` +
      `#Intent;package=${SPOTIFY_PACKAGE};scheme=https` +
      `;S.browser_fallback_url=${encodeURIComponent(`https://${target}`)};end`
    );
  }

  return null;
}

/** True when we are running on a device that understands `intent://` URLs. */
export function isAndroid(): boolean {
  return (
    typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent || "")
  );
}

/**
 * The href to actually use in this browser. On Android a YouTube or Spotify link
 * becomes an intent URL; everywhere else, and for every other link, it is what it
 * was.
 */
export function appHref(url: string): string {
  if (!isAndroid()) return url;
  return androidIntentFor(url) ?? url;
}
