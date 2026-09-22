# Same-text duplicate protection for YouTube comments/replies

## What is now blocked
For a single campaign (`linkId`), the backend rejects:

- the same YouTube comment/reply ID reused by another user (existing behavior)
- two different YouTube comment IDs whose verified comment text is the same
- two different YouTube reply IDs whose verified reply text is the same
- duplicate wording inside one user's own submission
- duplicate wording that matches an older/historical verified submission

The comparison uses text returned by the YouTube API, not frontend/user-supplied text.

## Normalization
The duplicate key is case-insensitive and ignores spacing/punctuation/symbol-only differences.
Examples treated as duplicates:

- `Nice video!` and `nice video`
- `GREAT   VIDEO!!!` and `great video`
- `Good video 🔥` and `good video`

Different wording such as `Nice video` and `Nice videos` remains different.
Unicode letters/marks are preserved, including Hindi text.

## Race-condition protection
New/updated screenshot records save SHA-256 text fingerprints in:

- `commentTextKeys`
- `replyTextKeys`

MongoDB unique indexes scope those fingerprints to the campaign (`linkId`). This means two users submitting the same wording at almost the same time cannot both be saved.

Historical records are not force-migrated or deleted. The controller scans historical verified actions so new submissions are still blocked if their wording matches an old submission.

## Production index step
Mongoose will normally create declared indexes, but for an explicit production rollout run:

```bash
node fix-indexes.js --apply
```

Do not use `--dedupe` for this text change; no historical data deletion is required.

## New API conflict codes
- `DUPLICATE_COMMENT_TEXT_IN_SUBMISSION`
- `DUPLICATE_REPLY_TEXT_IN_SUBMISSION`
- `COMMENT_TEXT_ALREADY_USED`
- `REPLY_TEXT_ALREADY_USED`

All return HTTP `409`.
