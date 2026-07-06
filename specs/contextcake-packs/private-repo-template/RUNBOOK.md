# Manual Fulfillment Runbook

## Trigger

A Stripe order completes for the base pack, the updates subscription, or a pilot checkout using a
100%-off promotion code.

## Steps

1. Open the Stripe order and record customer email, SKU, amount, promotion code, and timestamp.
2. Build or select the current release artifact:
   - plain-file zip from `dist/`;
   - private GitHub repo access for the Claude Code plugin channel.
3. Fulfill the requested channel:
   - Plain files: send the current release zip or authenticated private-release link.
   - Claude Code plugin: invite the customer's GitHub account as read collaborator and send
     marketplace/install instructions.
4. Record version delivered, fulfillment date, and channel in the tracking table.
5. For update subscribers, repeat fulfillment when `updates/CHANGELOG.md` gets a new release entry.
6. Send feedback separately 1-2 weeks later. Ask: "Would you personally have paid $X out of pocket
   for this?"

## Tracking Table

| Customer | SKU | Version | Channel | Paid/Test | Fulfilled | Feedback |
|---|---|---:|---|---|---|---|
|  |  |  |  |  |  |  |
