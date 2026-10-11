import { parse } from 'tldts-experimental';

// eTLD+1 of the page the user is on, e.g. "news.example.co.uk" -> "example.co.uk".
// Falls back to the hostname for IPs, localhost and the like; null for non-web pages.
export function siteKey(url) {
    try {
        const { protocol, hostname } = new URL(url);
        if (!['http:', 'https:'].includes(protocol) || !hostname) {
            return null;
        }
        return parse(hostname).domain || hostname;
    } catch {
        return null;
    }
}
