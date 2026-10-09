# SolPay Bot (Lite, free, MIT)

A crypto Q&A Telegram bot with free commands, market prices, and an X market-digest generator. Zero-cost stack, tested.

This is the **free Lite edition**. It answers everyone (`PAYWALL_ENABLED=false` by default): great to learn, demo, and build an audience.

**Want the paywall?** The [Pro edition](https://fkylo.gumroad.com/l/solpay-bot) ($49) adds: Solana payment verification (`!verify`), SQLite anti-replay, account linking, launch offer, spam cooldown, paywall test suites — plus a commercial license and 30-day install support.

- Live demo: `t.me/SolKestrelbot`
- Try it: `Copy-Item .env.example .env` → add a free Groq key → `npm install` → `npm run dev`

## Quickstart

```powershell
Copy-Item .env.example .env   # add LLM_API_KEY (Groq, free)
npm install
npm run dev                   # expect: LLM OK + "Agent ready"
npm run test:telegram         # paywall simulation (needs PAYWALL_ENABLED=true)
```

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Agent (Eliza runtime + Telegram loop) |
| `npm run test:solana` / `test:twitter` / `test:telegram` | Devnet + paywall simulations |
| `npm run gen-wallet` | Devnet wallet saved to `.env` |
| `npm run digest` | Market digest preview (`--post` publishes on X) |
| `npm run build` / `npm start` / `npm run lint` | Compile / run / check |

## Notes

- Telegram Bot API is 100% free (read + write). X free tier cannot read timelines (402) — documented, not a bug.
- Groq free tier has rate limits; paid loop + cooldown protect quota in Pro mode.
- The bot only runs while the host is on. `data/` and `.env` are gitignored — never commit secrets.

## License

MIT — see `LICENSE`. Pro edition (paywall + tests + support) is sold separately under a commercial license.
