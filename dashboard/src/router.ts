/** Path-based routing for the dashboard.
 *
 *  The dashboard used to live inside window.location.hash: #/work,
 *  #/p/<id>?tab=Files. Hashes work with zero server cooperation, but they
 *  look like a development artifact in an address bar the owner sees every
 *  day. Routes are now real paths: /work, /p/<id>?tab=Files, and the server
 *  answers any path the SPA owns with the entry document.
 *
 *  pushState fires no event (only back/forward does), so navigate() also
 *  dispatches ROUTE_CHANGE for the app shell to re-render. The stripped-hash
 *  input keeps old-style callers working, but new code should pass plain
 *  paths.
 */

const ROUTE_CHANGE = "nerdbot:routechange";

function targetOf(route: string): string {
  const path = route.startsWith("#") ? route.slice(1) : route;
  if (!path.startsWith("/")) return `/${path}`;
  return path;
}

/** Move to a route and re-render. Same-URL navigations re-render without
 *  adding a duplicate history entry, so hammering a sidebar item does not
 *  bury the back button under repeats. */
export function navigate(route: string): void {
  const target = targetOf(route);
  const here = window.location.pathname + window.location.search;
  if (here === target) {
    window.dispatchEvent(new Event(ROUTE_CHANGE));
    return;
  }
  window.history.pushState({ nerdbot: true }, "", target);
  window.dispatchEvent(new Event(ROUTE_CHANGE));
}

/** Subscribe to route changes: pushState navigation, back, forward, and the
 *  same-URL re-render dispatch all funnel through here. */
export function onRouteChange(callback: () => void): () => void {
  window.addEventListener("popstate", callback);
  window.addEventListener(ROUTE_CHANGE, callback);
  return () => {
    window.removeEventListener("popstate", callback);
    window.removeEventListener(ROUTE_CHANGE, callback);
  };
}

/** Turn same-origin anchor clicks into pushState navigation.
 *
 *  Many views render real <a href="/..."> links (breadcrumbs, table rows,
 *  cross-references), and they should keep working: right-click, copy
 *  link, open in a new tab all behave like the web. Left-clicks are
 *  intercepted so a click inside the app does not re-download and
 *  re-mount the whole dashboard. Modifier-click, middle-click, external
 *  targets and downloads fall through to the browser. */
export function installLinkInterceptor(): void {
  if (typeof document === "undefined") return;
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = (event.target as HTMLElement | null)?.closest("a");
    if (!anchor) return;
    const target = anchor.getAttribute("target");
    if (target && target !== "_self") return;
    if (anchor.hasAttribute("download")) return;
    const href = anchor.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    const url = new URL(anchor.href);
    if (url.origin !== window.location.origin) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash);
  });
}
