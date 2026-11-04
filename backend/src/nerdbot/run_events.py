"""Live fan-out for run execution events.

The orchestrator records every progress step to durable SQLite (see
``store.append_run_event``) so the workbench can show what an agent is doing
without holding one HTTP request open for the whole agent loop. This module
adds the missing half: a way for an SSE client to *subscribe* to a run and
receive events as they are written, including after a reconnect.

Three properties this module exists to hold:

1. **Replay on connect.** A subscriber that opens the stream after a run has
   already recorded events gets every event it missed, starting at ``after``.
   The durable log is the source of truth; the fan-out is a view over it.
2. **Live fan-out.** While a run is in flight, new events are pushed to every
   subscriber instead of waiting for the next poll.
3. **Terminal state is discoverable.** The stream endpoint asks the broker
   whether the run is finished, so the stream closes cleanly instead of
   hanging.

Subscribers are bounded: a slow client is dropped rather than backlogging the
writer, and the durable log is unaffected either way.

The broker deliberately does not touch the database. It only routes events
between the writer thread and the SSE subscribers; terminal detection is a
concern of the stream endpoint, which owns a request-scoped connection.
"""

from __future__ import annotations

import queue
import threading
from typing import Any

#: How many buffered events a subscriber may hold before being dropped.
SUBSCRIBER_QUEUE = 256


class _Subscriber:
    """One SSE client's receive queue.

    The writer pushes events here; the stream generator drains it. A full
    queue means the client is too slow, so it is silently dropped — the run
    itself does not slow down because one tab fell behind.
    """

    __slots__ = ("queue", "after")

    def __init__(self, after: int) -> None:
        self.queue: queue.Queue[Any] = queue.Queue(maxsize=SUBSCRIBER_QUEUE)
        self.after = after


class RunEventBroker:
    """Per-run subscriber registry, guarded by one lock.

    A run that has not started yet has no subscribers; a run that has finished
    keeps its durable log but stops being pushed to. The broker is the only
    thing that tracks subscribers, so the stream endpoint asks it for the
    live list and never guesses.
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._subscribers: dict[str, list[_Subscriber]] = {}

    def subscribe(self, run_id: str, after: int) -> _Subscriber:
        sub = _Subscriber(after)
        with self._lock:
            self._subscribers.setdefault(run_id, []).append(sub)
        return sub

    def unsubscribe(self, run_id: str, subscriber: _Subscriber) -> None:
        with self._lock:
            subs = self._subscribers.get(run_id)
            if subs is None:
                return
            subs.remove(subscriber)
            if not subs:
                self._subscribers.pop(run_id, None)

    def broadcast(self, run_id: str, event: dict[str, Any]) -> None:
        """Push one event to every subscriber of ``run_id``.

        Called from the thread that writes the event, so it must never raise:
        a dropped subscriber is a client problem, not a run problem.
        """
        with self._lock:
            subscribers = list(self._subscribers.get(run_id, []))
        for sub in subscribers:
            try:
                sub.queue.put_nowait(event)
            except queue.Full:
                # The client is behind; drop it rather than block the writer.
                self.unsubscribe(run_id, sub)

    def subscriber_count(self, run_id: str) -> int:
        with self._lock:
            return len(self._subscribers.get(run_id, []))


# A single broker per server process. Runs are short-lived and the registry is
# cleared when their last subscriber disconnects, so memory stays bounded.
broker = RunEventBroker()
