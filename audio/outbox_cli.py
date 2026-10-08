"""
Operator tool for the live transport's durable outbox (see speech/live/outbox.py).

  python outbox_cli.py status                 what is waiting or refused, per meeting (no network)
  python outbox_cli.py replay <meeting-id>    deliver the segments waiting for that meeting

When the meeting API refuses to end a meeting because segments are missing (transcript-incomplete), the
missing segments are usually waiting in this outbox. `replay` delivers them. The API keeps accepting
segments from sessions that already ended until the meeting is completed, failed or cancelled.

replay reads MEETING_API_URL (the server origin, e.g. http://127.0.0.1:3103) and MEETING_TICKET from the
environment. The ticket is a credential, so it is never taken from the command line. Mint one with
POST /api/v1/meetings/<id>/ticket (admin).

Exit code: 0 when nothing is left waiting and nothing new was refused, 1 otherwise.
"""

import argparse
import json
import os
import sys
import urllib.request
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from speech.live.ids import require_uuid  # noqa: E402
from speech.live.outbox import Outbox, OutboxError  # noqa: E402
from speech.live.persistence import ALREADY_EXISTS, FAILED, INSERTED, REJECTED, MeetingPersistence  # noqa: E402

DEFAULT_OUTBOX_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "outbox")


def status_report(outbox: Outbox) -> dict:
    meetings = []
    for meeting_id in outbox.meetings():
        try:
            pending = outbox.pending(meeting_id)
            rejected = outbox.rejected(meeting_id)
        except (OutboxError, OSError) as err:
            meetings.append({"meetingId": meeting_id, "unreadable": str(err)})
            continue
        meetings.append(
            {
                "meetingId": meeting_id,
                "failed": len(pending),
                "rejected": len(rejected),
                "rejectedReasons": dict(Counter(entry.get("reason") or "unknown" for entry in rejected)),
            }
        )
    return {"durable": outbox.durable, "meetings": meetings}


def replay(outbox: Outbox, meeting_id: str, api_url: str, ticket: str, opener=urllib.request.urlopen) -> dict:
    persistence = MeetingPersistence(api_url, meeting_id, ticket, outbox, opener=opener)
    counts = persistence.flush()
    return {
        "meetingId": meeting_id,
        "inserted": counts[INSERTED],
        "alreadyExists": counts[ALREADY_EXISTS],
        "rejectedNow": counts[REJECTED],
        "failedNow": counts[FAILED],
        "stillWaiting": len(outbox.pending(meeting_id)),
        "quarantinedTotal": len(outbox.rejected(meeting_id)),
    }


def main(argv=None, env=None, out=None, opener=urllib.request.urlopen) -> int:
    env = os.environ if env is None else env
    out = sys.stdout if out is None else out
    parser = argparse.ArgumentParser(description="Inspect or replay the live transport's durable outbox.")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status", help="show what is waiting or refused, per meeting")
    replay_parser = commands.add_parser("replay", help="deliver the segments waiting for one meeting")
    replay_parser.add_argument("meeting_id", help="the meeting's UUID")
    args = parser.parse_args(argv)

    outbox = Outbox(env.get("LIVE_OUTBOX_DIR") or DEFAULT_OUTBOX_DIR)

    if args.command == "status":
        report = status_report(outbox)
        print(json.dumps(report, indent=2), file=out)
        return 0 if all(not m.get("failed") and not m.get("rejected") and "unreadable" not in m for m in report["meetings"]) else 1

    try:
        meeting_id = require_uuid(args.meeting_id, "meeting_id")
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2
    api_url = (env.get("MEETING_API_URL") or "").rstrip("/")
    ticket = env.get("MEETING_TICKET") or ""
    if not api_url or not ticket:
        print("error: set MEETING_API_URL (the server origin) and MEETING_TICKET in the environment", file=sys.stderr)
        return 2
    result = replay(outbox, meeting_id, api_url, ticket, opener=opener)
    print(json.dumps(result, indent=2), file=out)
    return 0 if result["stillWaiting"] == 0 and result["rejectedNow"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
