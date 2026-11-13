/**
 * One animation loop for every face on the page.
 *
 * Each animated avatar used to run its own `requestAnimationFrame`. Two is
 * comfortable and twenty is a page that janks — which is why the lists draw a
 * still frame. Binding a bot's face to its real status makes more faces worth
 * animating, so the loop is shared first: one scheduler, one clock, and the
 * avatars subscribe to it.
 *
 * The clock is bounded. A hidden tab has its `requestAnimationFrame` suspended,
 * so the gap between two frames can be minutes; without the cap a face would
 * jump forward on the way back. `MAX_DT` is the largest step the engine will
 * ever be asked to take, and it is the same number the component used when it
 * owned its own clock.
 *
 * The scheduler is injected rather than imported, so the loop can be driven a
 * frame at a time by a test instead of by a browser.
 */
/** The largest step the clock will take, in seconds. */
export const MAX_DT = 0.064;
export function createTicker(schedule) {
    const ticks = new Set();
    let handle = null;
    /** The previous frame's timestamp, or `null` for "no predecessor". */
    let last = null;
    let clock = 0;
    const frame = (ms) => {
        handle = null;
        // The first frame after an idle spell has no predecessor to measure
        // against: stepping by the length of that spell is the jump this cap
        // exists to prevent.
        const dt = last === null ? 0 : Math.min((ms - last) / 1000, MAX_DT);
        last = ms;
        clock += dt;
        // Copied: a tick may unsubscribe itself while the loop is iterating.
        for (const tick of [...ticks])
            tick(clock);
        if (ticks.size > 0)
            handle = schedule.request(frame);
    };
    return {
        now: () => clock,
        subscribers: () => ticks.size,
        subscribe(tick) {
            ticks.add(tick);
            if (handle === null) {
                last = null;
                handle = schedule.request(frame);
            }
            return () => {
                ticks.delete(tick);
                if (ticks.size === 0 && handle !== null) {
                    schedule.cancel(handle);
                    handle = null;
                    last = null;
                }
            };
        },
    };
}
/**
 * The browser's scheduler. Guarded so importing this module outside a browser
 * — in a test — does not throw before anyone has subscribed.
 */
const browserFrames = {
    request(callback) {
        if (typeof requestAnimationFrame !== "function")
            return 0;
        return requestAnimationFrame(callback);
    },
    cancel(handle) {
        if (typeof cancelAnimationFrame === "function" && handle !== 0) {
            cancelAnimationFrame(handle);
        }
    },
};
/** The loop the avatars share. */
export const ticker = createTicker(browserFrames);
