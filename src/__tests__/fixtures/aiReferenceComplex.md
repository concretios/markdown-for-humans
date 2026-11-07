---
title: "(L2) complex reference fixture (L2)"
tags: "(L3) lists, tables, code (L3)"
owner: "(L4) docs team (L4)"
---

# (L7) Complex document (L7)

(L9) A single line paragraph with **bold**, *italic*, `code` and a [link](https://example.com). (L9)

(L11) A hard-wrapped paragraph starts here, (L11)
(L12) continues with **bold words** on its second line, (L12)
(L13) then a third line with `inline code`, (L13)
(L14) and ends on a fourth line. (L14)

(L16) This line ends with two spaces for a hard break (L16)  
(L17) and this is the line after that break. (L17)

(L19) This line ends with a backslash break (L19)\
(L20) followed by the next line. (L20)



## (L24) Lists after three blank lines (L24)

- (L26) bullet one (L26)
- (L27) bullet two has **bold** text (L27)
  (L28) and a continuation line (L28)
  - (L29) nested level two (L29)
    - (L30) nested level three (L30)
      (L31) level three continues (L31)
    - (L32) another level three (L32)
  - (L33) back to level two (L33)
- (L34) bullet three (L34)

1. (L36) ordered one (L36)
2. (L37) ordered two (L37)
   - (L38) bullet under ordered two (L38)
   - (L39) second bullet under ordered two (L39)
     1. (L40) ordered under that bullet (L40)
     2. (L41) another ordered under that bullet (L41)
3. (L42) ordered three (L42)

(L44) A loose list follows: (L44)

- (L46) loose item one (L46)

  (L48) second paragraph of loose item one (L48)

- (L50) loose item two (L50)

  ```js
  /* (L53) */ const insideList = 1; // (L53)
  /* (L54) */ const alsoInsideList = 2; // (L54)
  ```

- (L57) loose item three (L57)

  > (L59) a quote inside a list item (L59)

(L61) Tasks: (L61)

- [ ] (L63) open task (L63)
- [x] (L64) done task with `code` (L64)
  - [ ] (L65) nested open task (L65)
  - [x] (L66) nested done task (L66)
- [ ] (L67) last task (L67)

## (L69) Quotes and alerts (L69)

> (L71) quote line one (L71)
> (L72) quote line two (L72)
>
> (L74) second quote paragraph (L74)
>
> - (L76) list inside the quote (L76)
> - (L77) second item inside the quote (L77)

> [!NOTE]
> (L80) note line one (L80)
> (L81) note line two (L81)

> [!WARNING]
> (L84) warning first paragraph (L84)
>
> (L86) warning second paragraph (L86)
> (L87) with a second line (L87)

> [!TIP]
> (L90) tip text (L90)

### (L92) Tables (L92)

| Part | Qty | Note |
| :--- | ---: | :---: |
| (L96) Bolt | 4 | note (L96) |
| (L97) Nut | 4 | note (L97) |
| (L98) Washer | 4 | note (L98) |
| (L99) Spring **pin** | 4 | note (L99) |
| (L100) Cotter `key` | 4 | note (L100) |
| (L101) Shim \| thin | 4 | note (L101) |
| (L102) Gasket | 4 | note (L102) |
| (L103) Seal | 4 | note (L103) |
| (L104) Bearing | 4 | note (L104) |
| (L105) Bushing | 4 | note (L105) |
| (L106) Circlip | 4 | note (L106) |
| (L107) Rivet | 4 | note (L107) |
| (L108) empty cells |  | (L108) |

(L110) A second table, compact: (L110)

|a|b|
|-|-|
|(L114) x|y (L114)|
|(L115) [link](https://example.com)|*z* (L115)|

#### (L117) Code (L117)

```ts
/* (L120) */ export const first = 1; // (L120)

/* (L122) */ export const third = 3; // (L122)
/* (L123) */ function wrap() { return `a`; } // (L123)
```

~~~text
(L127) a tilde fence line (L127)
(L128) a second tilde fence line (L128)
~~~

````md
(L132) a longer fence can hold (L132)
```
(L134) three backticks inside it (L134)
```
(L136) and keep going (L136)
````

(L139) A paragraph before a rule. (L139)

---

(L143) A paragraph after the rule, with <kbd>Ctrl</kbd> inline HTML. (L143)

<!-- a comment that renders as a marker -->

(L147) A paragraph with a reference link to [the guide][guide]. (L147)


## (L150) Second half after two blank lines (L150)

(L152) Repeated paragraph 1 line one, (L152)
(L153) repeated paragraph 1 line two. (L153)

- (L155) repeated list 1 item a (L155)
  - (L156) repeated list 1 nested (L156)
- (L157) repeated list 1 item b (L157)

| key | value |
| --- | --- |
| (L161) alpha 1 | one (L161) |
| (L162) omega 1 | two (L162) |

(L164) Repeated paragraph 2 line one, (L164)
(L165) repeated paragraph 2 line two. (L165)

- (L167) repeated list 2 item a (L167)
  - (L168) repeated list 2 nested (L168)
- (L169) repeated list 2 item b (L169)

| key | value |
| --- | --- |
| (L173) alpha 2 | one (L173) |
| (L174) omega 2 | two (L174) |

(L176) Repeated paragraph 3 line one, (L176)
(L177) repeated paragraph 3 line two. (L177)

- (L179) repeated list 3 item a (L179)
  - (L180) repeated list 3 nested (L180)
- (L181) repeated list 3 item b (L181)

| key | value |
| --- | --- |
| (L185) alpha 3 | one (L185) |
| (L186) omega 3 | two (L186) |

(L188) Repeated paragraph 4 line one, (L188)
(L189) repeated paragraph 4 line two. (L189)

- (L191) repeated list 4 item a (L191)
  - (L192) repeated list 4 nested (L192)
- (L193) repeated list 4 item b (L193)

| key | value |
| --- | --- |
| (L197) alpha 4 | one (L197) |
| (L198) omega 4 | two (L198) |

(L200) Repeated paragraph 5 line one, (L200)
(L201) repeated paragraph 5 line two. (L201)

- (L203) repeated list 5 item a (L203)
  - (L204) repeated list 5 nested (L204)
- (L205) repeated list 5 item b (L205)

| key | value |
| --- | --- |
| (L209) alpha 5 | one (L209) |
| (L210) omega 5 | two (L210) |

(L212) Repeated paragraph 6 line one, (L212)
(L213) repeated paragraph 6 line two. (L213)

- (L215) repeated list 6 item a (L215)
  - (L216) repeated list 6 nested (L216)
- (L217) repeated list 6 item b (L217)

| key | value |
| --- | --- |
| (L221) alpha 6 | one (L221) |
| (L222) omega 6 | two (L222) |

(L224) The last paragraph. (L224)

[guide]: https://example.com/guide
