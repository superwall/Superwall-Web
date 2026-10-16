# Paywall preload benchmark

`register({ placement: "web2app_onboarding" })` right after `await sw.ready`,
cold loads in Chromium emulating an iPhone 13. Every response shares one link
shaped like Chrome DevTools' presets (Slow 4G: 1.44 Mbps, 562 ms latency;
Fast 4G: 8.1 Mbps, 165 ms latency). Medians of 5 runs per cell.

- before: `origin/main` (4b6ebc5)
- after: 12a53a6

| Network | SDK | register → paywall loaded | page start → paywall loaded | onboarding.html downloads | other paywalls' bytes before it loaded | all paywall bytes before it loaded |
|---|---|---|---|---|---|---|
| Slow 4G | before | 11.65 s | 16.13 s | 2 | 580 KB | 1.84 MB |
| Slow 4G | after | 6.37 s | 10.85 s | 1 | 0 KB | 875 KB |
| Fast 4G | before | 2.83 s | 4.00 s | 2 | 831 KB | 2.52 MB |
| Fast 4G | after | 1.28 s | 2.46 s | 1 | 0 KB | 875 KB |

The onboarding paywall is an 875 KB document. Two other live campaigns are
reachable from other placements: home (24 KB document, 929 KB script, 2.78 MB
image) and special offer (160 KB document, 540 KB image).
