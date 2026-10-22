import { useEffect, useId, useMemo, useRef, useState } from "react";
import { NOTIF_BLUE } from "./decor";
import { BotEngine, type BotFrame } from "./engine";
import { EXPRESSION_BY_ID } from "./expressions";
import { DEFAULT_FACE, faceInk, facePlate, facePlateHex, normalizeFace, type FaceSpec } from "./face";
import { clamp, easings } from "./math";
import { lookTarget, TURN_TIME } from "./gaze";
import { DEMI_CORPS, DEMI_VIEWBOX, RAYON } from "./repere";
import { SHAPE_BY_ID, mixHex } from "./skins";
import { STATE_BY_ID, type StateId } from "./states";

/**
 * The bot avatar.
 *
 * A React client of the engine in `src/bot/`. The engine is clock-free and
 * pure, so this component only has to feed it a time and draw the frame it
 * returns.
 *
 * Two rendering modes:
 *
 * - static: one frame, no loop. Used everywhere a face appears in a list,
 *   where twenty live avatars would cost twenty animation loops.
 * - animated: a `requestAnimationFrame` loop with a delta-bounded clock, so a
 *   backgrounded tab does not jump forward when it comes back.
 */

export interface BotAvatarProps {
  /** The owner's choice: body shape, colour and resting expression. */
  face?: FaceSpec | null;
  /** Rendered size in pixels. */
  size?: number;
  /** The animated state to show. `idle` is the resting face. */
  state?: StateId;
  /** Animate, or render a single frame. */
  animated?: boolean;
  /** The time of the single frame, in seconds, when not animating. */
  frozenAt?: number;
  /** Let the eyes follow the pointer. */
  follow?: boolean;
  /** Crop to the body only (small avatars) or keep room for the rings. */
  frame?: "body" | "scene";
  /** The plate behind the face. `auto` picks the one that contrasts. */
  plate?: "auto" | "none";
  className?: string;
  /** Accessible name. Omit for decorative avatars. */
  label?: string;
}

/** The time of the frozen frame: the resting pose, no blink in progress. */
const STILL = 1;

export function BotAvatar({
  face,
  size = 96,
  state = "idle",
  animated = false,
  frozenAt = STILL,
  follow = false,
  frame = "body",
  plate = "auto",
  className = "",
  label,
}: BotAvatarProps) {
  const resolved = useMemo(() => normalizeFace(face ?? DEFAULT_FACE), [face]);
  const shapeRadii = useMemo(
    () => SHAPE_BY_ID.get(resolved.shape)?.radii ?? null,
    [resolved.shape],
  );
  const expression = useMemo(
    () => EXPRESSION_BY_ID.get(resolved.expression) ?? null,
    [resolved.expression],
  );
  const ink = faceInk(resolved);
  const plateColor = facePlate(resolved);
  const plateHex = facePlateHex(resolved);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const clockRef = useRef(0);
  const lastRef = useRef(0);

  // One engine per mounted avatar. It is created once and then driven by
  // dated setters, so the rendering stays a pure function of time.
  const [engine] = useState(
    () => new BotEngine(RAYON, state, shapeRadii, expression),
  );

  /**
   * The static frame is DERIVED, not stored: a face that never moves is a
   * function of its shape, its expression and its state, and deriving it
   * means it can never disagree with the props.
   */
  const stillFrame = useMemo(() => {
    if (animated) return null;
    const own = new BotEngine(RAYON, state, shapeRadii, expression);
    if (state !== "idle") own.setState(state, 0);
    return own.sample(frozenAt);
  }, [animated, state, shapeRadii, expression, frozenAt]);

  const [liveFrame, setLiveFrame] = useState<BotFrame | null>(null);

  // A fresh frame whenever the shape, the expression or the state changes.
  useEffect(() => {
    engine.setShape(shapeRadii, clockRef.current);
    engine.setExpression(expression, clockRef.current);
    engine.setState(state, clockRef.current);
  }, [engine, shapeRadii, expression, state]);

  useEffect(() => {
    if (!animated) return;
    let raf = 0;
    let disposed = false;

    const tick = (ms: number) => {
      if (disposed) return;
      raf = requestAnimationFrame(tick);
      // Scene clock with a bounded delta: a hidden tab then shown again
      // resumes without jumping forward (rAF is suspended in the meantime).
      const dt = lastRef.current ? Math.min((ms - lastRef.current) / 1000, 0.064) : 0;
      lastRef.current = ms;
      clockRef.current += dt;
      setLiveFrame(engine.sample(clockRef.current));
    };
    raf = requestAnimationFrame(tick);
    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      lastRef.current = 0;
    };
  }, [engine, animated]);

  // Pointer tracking: the eyes follow the cursor, but only on the states
  // that carry the resting face — elsewhere the gaze pose IS the animation.
  useEffect(() => {
    if (!animated || !follow) return;
    let pointer: { x: number; y: number } | null = null;
    let aiming = false;
    let turnSince = 0;

    const onMove = (event: PointerEvent) => {
      // Touch has no cursor trailing it: a lifted finger would leave the
      // gaze fixed on the last touched point, which reads as a bug.
      if (event.pointerType === "touch") return;
      pointer = { x: event.clientX, y: event.clientY };
    };
    const onLeave = () => {
      pointer = null;
    };

    const aim = () => {
      if (!STATE_BY_ID.get(engine.state)?.baseFace) {
        if (aiming) {
          engine.setLook(null, clockRef.current, TURN_TIME);
          aiming = false;
        }
        return;
      }
      const box = svgRef.current?.getBoundingClientRect();
      // A box with no surface: there is nothing to aim at, and the
      // normalisation below would become `0 / 0`, i.e. `NaN`. The engine
      // KEEPS the last target: a single `NaN` set once stays for good.
      if (!box || box.width === 0 || box.height === 0) return;
      if (!aiming) turnSince = clockRef.current;
      const halfWidth = Math.max(1, window.innerWidth / 2);
      const halfHeight = Math.max(1, window.innerHeight / 2);
      engine.setLook(
        lookTarget({
          nx: pointer ? clamp((pointer.x - (box.left + box.width / 2)) / halfWidth, -1, 1) : 0,
          ny: pointer ? clamp((pointer.y - (box.top + box.height / 2)) / halfHeight, -1, 1) : 0,
          tour: easings.easeOutQuint(clamp((clockRef.current - turnSince) / TURN_TIME)),
          pointer: pointer !== null,
        }),
        clockRef.current,
      );
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
  }, [engine, animated, follow]);

  const half = frame === "scene" ? DEMI_VIEWBOX : DEMI_CORPS;
  // A unique id for the mask, so two avatars on the same page do not share
  // one. React's useId is unique per instance; the brackets it adds are
  // stripped because they are not welcome in a url(#…) reference.
  const maskId = `bot-mask-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;

  const f = animated ? liveFrame : stillFrame;
  const eyes = f?.eyes ?? [];

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
      className={className}
      role={label ? "img" : "presentation"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      <defs>
        {/*
          The eyes are real holes punched through the body (as on x.ai), not
          white shapes laid on top: they are therefore cut by the silhouette
          on their own when they slide towards the edge.
        */}
        <mask
          id={maskId}
          maskUnits="userSpaceOnUse"
          x={-half}
          y={-half}
          width={half * 2}
          height={half * 2}
        >
          <path d={f?.bodyPath ?? ""} fill="#fff" />
          <path d={eyes[0]?.d ?? ""} transform={eyes[0]?.matrix} opacity={eyes[0]?.alpha} fill="#000" />
          <path d={eyes[1]?.d ?? ""} transform={eyes[1]?.matrix} opacity={eyes[1]?.alpha} fill="#000" />
          {f?.notch ? (
            <circle cx={f.notch.x} cy={f.notch.y} r={f.notch.r} fill="#000" />
          ) : null}
        </mask>
        {(f?.arcs ?? []).map((arc) => (
          <linearGradient
            key={arc.id}
            id={`${maskId}-${arc.id}`}
            gradientUnits="userSpaceOnUse"
            x1={arc.grad.x1}
            y1={arc.grad.y1}
            x2={arc.grad.x2}
            y2={arc.grad.y2}
          >
            {arc.grad.stops.map((c, i) => (
              <stop
                key={i}
                offset={i / (arc.grad.stops.length - 1)}
                stopColor={c}
              />
            ))}
          </linearGradient>
        ))}
      </defs>

      {/* the back half of the orbits: drawn before the body, so it is hidden */}
      <g fill="none" strokeLinecap="round">
        {(f?.arcs ?? []).map((arc) => (
          <path
            key={`b${arc.id}`}
            d={arc.back}
            stroke={`url(#${maskId}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>

      {/*
        The plate the face is drawn on. The eyes are holes punched through
        the body, so the plate is what shows in them — and it is also what
        keeps the near-black and near-white bodies of the palette legible.
      */}
      {plate !== "none" ? (
        <rect
          x={-half}
          y={-half}
          width={half * 2}
          height={half * 2}
          rx={half * 0.28}
          fill={plateColor}
        />
      ) : null}

      {/* the burst particles pass behind the core */}
      {f?.dotsBehind
        ? (f.dots ?? []).map((dot, i) =>
            dot.d ? (
              <path
                key={`pb${i}`}
                d={dot.d}
                transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`}
                fill={dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1)}
                opacity={dot.opacity}
              />
            ) : (
              <circle
                key={`pb${i}`}
                cx={dot.x}
                cy={dot.y}
                r={dot.r}
                fill={dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1)}
                opacity={dot.opacity}
              />
            ),
          )
        : null}

      <g opacity={f?.bodyAlpha ?? 1}>
        <g mask={`url(#${maskId})`}>
          <rect x={-half} y={-half} width={half * 2} height={half * 2} fill={ink} />
        </g>
      </g>

      {f && !f.dotsBehind
        ? (f.dots ?? []).map((dot, i) =>
            dot.d ? (
              <path
                key={`pf${i}`}
                d={dot.d}
                transform={`translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})`}
                fill={dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1)}
                opacity={dot.opacity}
              />
            ) : (
              <circle
                key={`pf${i}`}
                cx={dot.x}
                cy={dot.y}
                r={dot.r}
                fill={dot.color ?? mixHex(plateHex, ink, dot.depth ?? 1)}
                opacity={dot.opacity}
              />
            ),
          )
        : null}

      {f?.notif ? (
        <circle cx={f.notif.x} cy={f.notif.y} r={f.notif.r} fill={NOTIF_BLUE} />
      ) : null}

      {/* the front half of the orbits */}
      <g fill="none" strokeLinecap="round">
        {(f?.arcs ?? []).map((arc) => (
          <path
            key={`f${arc.id}`}
            d={arc.front}
            stroke={`url(#${maskId}-${arc.id})`}
            strokeWidth={arc.width}
            opacity={arc.opacity}
          />
        ))}
      </g>
    </svg>
  );
}
