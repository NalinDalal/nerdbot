import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useReducedMotion } from "../motion";
import { NOTIF_BLUE } from "./decor";
import { BotEngine } from "./engine";
import { EXPRESSION_BY_ID } from "./expressions";
import { DEFAULT_FACE, faceInk, facePlate, facePlateHex, normalizeFace } from "./face";
import { clamp, easings } from "./math";
import { lookTarget, TURN_TIME } from "./gaze";
import { DEMI_CORPS, DEMI_VIEWBOX, RAYON } from "./repere";
import { SHAPE_BY_ID, mixHex } from "./skins";
import { STATE_BY_ID } from "./states";
import { ticker } from "./ticker";
/** The time of the frozen frame: the resting pose, no blink in progress. */
const STILL = 1;
export function BotAvatar({ face, size = 96, state = "idle", animated = false, frozenAt = STILL, follow = false, frame = "body", plate = "auto", className = "", label, }) {
    const resolved = useMemo(() => normalizeFace(face ?? DEFAULT_FACE), [face]);
    const shapeRadii = useMemo(() => SHAPE_BY_ID.get(resolved.shape)?.radii ?? null, [resolved.shape]);
    const expression = useMemo(() => EXPRESSION_BY_ID.get(resolved.expression) ?? null, [resolved.expression]);
    const ink = faceInk(resolved);
    const plateColor = facePlate(resolved);
    const plateHex = facePlateHex(resolved);
    const svgRef = useRef(null);
    // One engine per mounted avatar. It is created once and then driven by
    // dated setters, so the rendering stays a pure function of time.
    const [engine] = useState(() => new BotEngine(RAYON, state, shapeRadii, expression));
    /**
     * Animated only if asked for AND permitted. The stylesheet's
     * `prefers-reduced-motion` block cannot reach an SVG driven by
     * `requestAnimationFrame`, so the preference is read here instead.
     */
    const reduced = useReducedMotion();
    const running = animated && !reduced;
    /**
     * The static frame is DERIVED, not stored: a face that never moves is a
     * function of its shape, its expression and its state, and deriving it
     * means it can never disagree with the props.
     *
     * It is also the first frame an animated face draws, so the component
     * never commits an empty silhouette while the loop wakes up.
     */
    const posedStill = useMemo(() => {
        const own = new BotEngine(RAYON, state, shapeRadii, expression);
        if (state !== "idle")
            own.setState(state, 0);
        return own.sample(frozenAt);
    }, [state, shapeRadii, expression, frozenAt]);
    const [liveFrame, setLiveFrame] = useState(null);
    // A fresh frame whenever the shape, the expression or the state changes.
    // The time comes from the shared clock, so the morph starts from the
    // moment the page is actually showing.
    useEffect(() => {
        const now = ticker.now();
        engine.setShape(shapeRadii, now);
        engine.setExpression(expression, now);
        engine.setState(state, now);
    }, [engine, shapeRadii, expression, state]);
    useEffect(() => {
        if (!running)
            return;
        const draw = (t) => setLiveFrame(engine.sample(t));
        // Draw once immediately: a face that waits for its first frame would be
        // blank until then.
        draw(ticker.now());
        return ticker.subscribe(draw);
    }, [engine, running]);
    // Pointer tracking: the eyes follow the cursor, but only on the states
    // that carry the resting face — elsewhere the gaze pose IS the animation.
    useEffect(() => {
        if (!running || !follow)
            return;
        let pointer = null;
        let aiming = false;
        let turnSince = 0;
        const onMove = (event) => {
            // Touch has no cursor trailing it: a lifted finger would leave the
            // gaze fixed on the last touched point, which reads as a bug.
            if (event.pointerType === "touch")
                return;
            pointer = { x: event.clientX, y: event.clientY };
        };
        const onLeave = () => {
            pointer = null;
        };
        const aim = () => {
            if (!STATE_BY_ID.get(engine.state)?.baseFace) {
                if (aiming) {
                    engine.setLook(null, ticker.now(), TURN_TIME);
                    aiming = false;
                }
                return;
            }
            const box = svgRef.current?.getBoundingClientRect();
            // A box with no surface: there is nothing to aim at, and the
            // normalisation below would become `0 / 0`, i.e. `NaN`. The engine
            // KEEPS the last target: a single `NaN` set once stays for good.
            if (!box || box.width === 0 || box.height === 0)
                return;
            if (!aiming)
                turnSince = ticker.now();
            const halfWidth = Math.max(1, window.innerWidth / 2);
            const halfHeight = Math.max(1, window.innerHeight / 2);
            engine.setLook(lookTarget({
                nx: pointer ? clamp((pointer.x - (box.left + box.width / 2)) / halfWidth, -1, 1) : 0,
                ny: pointer ? clamp((pointer.y - (box.top + box.height / 2)) / halfHeight, -1, 1) : 0,
                tour: easings.easeOutQuint(clamp((ticker.now() - turnSince) / TURN_TIME)),
                pointer: pointer !== null,
            }), ticker.now());
            aiming = true;
        };
        const onTick = () => aim();
        window.addEventListener("pointermove", onMove);
        document.addEventListener("pointerleave", onLeave);
        const timer = window.setInterval(onTick, 50);
        return () => {
            window.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerleave", onLeave);
            window.clearInterval(timer);
        };
    }, [engine, running, follow]);
    const half = frame === "scene" ? DEMI_VIEWBOX : DEMI_CORPS;
    // A unique id for the mask, so two avatars on the same page do not share
    // one. React's useId is unique per instance; the brackets it adds are
    // stripped because they are not welcome in a url(#…) reference.
    const maskId = `bot-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
    const f = running ? (liveFrame ?? posedStill) : posedStill;
    const eyes = f?.eyes ?? [];
    return (_jsxs("svg", { ref: svgRef, width: size, height: size, viewBox: `${-half} ${-half} ${half * 2} ${half * 2}`, className: className, role: label ? "img" : "presentation", "aria-label": label, "aria-hidden": label ? undefined : true, focusable: "false", children: [_jsxs("defs", { children: [_jsxs("mask", { id: maskId, maskUnits: "userSpaceOnUse", x: -half, y: -half, width: half * 2, height: half * 2, children: [_jsx("path", { d: f?.bodyPath ?? "", fill: "#fff" }), _jsx("path", { d: eyes[0]?.d ?? "", transform: eyes[0]?.matrix, opacity: eyes[0]?.alpha, fill: "#000" }), _jsx("path", { d: eyes[1]?.d ?? "", transform: eyes[1]?.matrix, opacity: eyes[1]?.alpha, fill: "#000" }), f?.notch ? (_jsx("circle", { cx: f.notch.x, cy: f.notch.y, r: f.notch.r, fill: "#000" })) : null] }), (f?.arcs ?? []).map((arc) => (_jsx("linearGradient", { id: `${maskId}-${arc.id}`, gradientUnits: "userSpaceOnUse", x1: arc.grad.x1, y1: arc.grad.y1, x2: arc.grad.x2, y2: arc.grad.y2, children: arc.grad.stops.map((c, i) => (_jsx("stop", { offset: i / (arc.grad.stops.length - 1), stopColor: c }, i))) }, arc.id)))] }), _jsx("g", { fill: "none", strokeLinecap: "round", children: (f?.arcs ?? []).map((arc) => (_jsx("path", { d: arc.back, stroke: `url(#${maskId}-${arc.id})`, strokeWidth: arc.width, opacity: arc.opacity }, `b${arc.id}`))) }), plate !== "none" ? (_jsx("rect", { x: -half, y: -half, width: half * 2, height: half * 2, rx: half * 0.28, fill: plateColor })) : null, f?.dotsBehind
                ? (f.dots ?? []).map((dot, i) => dot.d ? (_jsx("path", { d: dot.d, transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`, fill: dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1), opacity: dot.opacity }, `pb${i}`)) : (_jsx("circle", { cx: dot.x, cy: dot.y, r: dot.r, fill: dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1), opacity: dot.opacity }, `pb${i}`)))
                : null, _jsx("g", { opacity: f?.bodyAlpha ?? 1, children: _jsx("g", { mask: `url(#${maskId})`, children: _jsx("rect", { x: -half, y: -half, width: half * 2, height: half * 2, fill: ink }) }) }), f && !f.dotsBehind
                ? (f.dots ?? []).map((dot, i) => dot.d ? (_jsx("path", { d: dot.d, transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`, fill: dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1), opacity: dot.opacity }, `pf${i}`)) : (_jsx("circle", { cx: dot.x, cy: dot.y, r: dot.r, fill: dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1), opacity: dot.opacity }, `pf${i}`)))
                : null, f?.notif ? (_jsx("circle", { cx: f.notif.x, cy: f.notif.y, r: f.notif.r, fill: NOTIF_BLUE })) : null, _jsx("g", { fill: "none", strokeLinecap: "round", children: (f?.arcs ?? []).map((arc) => (_jsx("path", { d: arc.front, stroke: `url(#${maskId}-${arc.id})`, strokeWidth: arc.width, opacity: arc.opacity }, `f${arc.id}`))) })] }));
}
