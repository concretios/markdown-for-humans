# Feedback evidence v2 fixture

## Decision rules

| Situation | Assistant action | Human involvement |
| :--- | :---: | ---: |
| Password \| reset | [Draft](./draft.md) | Agent approves |
| Billing dispute | Draft an answer | Billing specialist approves |

## Code

```typescript
const role = "admin";

if (role) {
  grant(role);
}
```

## Merged table

<table>
  <tr><th>State</th><th colspan="2">Actions</th></tr>
  <tr><td>Open</td><td>Review</td><td>Approve</td></tr>
</table>

## Escaping table

| Name | Notes |
| --- | --- |
| A\B | Close `-->` |

## Formatted prose

Choose [the **more reliable** option](./safe.md "Safety note") before shipping.

## Authored fence

~~~~JavaScript
const fence = "```";
console.log(fence);
~~~~

## Diagram

```mermaid
flowchart LR
  Start --> Finish
```

## Cross-block selection

First *formatted* paragraph.

Second [linked](./next.md) paragraph.
