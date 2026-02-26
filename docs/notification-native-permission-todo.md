# TODO: Native Notification Permission Follow-up

## Context
- Notification API calls can return `{"success":true,"delivered":1}` while users still see no system notification.
- This is expected in some cases when running inside an iframe or when browser notification permission is not granted.
- Current behavior requests permission lazily when a notification arrives, which may be blocked or silently ignored by browsers without a user gesture.

## Recommended Follow-up
- Add an explicit `Enable notifications` control on the session page.
- Trigger `Notification.requestPermission()` only from a direct user click.
- Display current permission state (`granted`, `default`, `denied`) in the UI.
- Keep native notification delivery active only when permission is `granted`.
- Show clear guidance when notifications are blocked (iframe restrictions, denied permission, or unsupported browser context).

## Why
- Improves reliability and debuggability for users testing notification flow.
- Avoids silent failure where websocket delivery succeeds but OS notification never appears.
