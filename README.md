# Dream — your gym buddy 💪

A personal fitness tracker (just for you). Tracks **steps, calories, weight, goals,
and gym streaks** — all stored locally on your device, no account, no server, no cost.

## Features
- 👟 **Steps** — daily step goal, progress ring, auto-calculated calories burned & distance
- 🔥 **Calories** — log food (in) and activity (out); steps automatically count toward "out"
- ⚖️ **Weight** — log weigh-ins, BMI, healthy range, progress to goal weight
- 🎯 **Goals & streaks** — daily checklist + gym streak counter + calendar history
- 🧮 **Smart targets** — BMR/TDEE and protein targets from your profile
- 🔔 **Reminders** — nudge if you haven't hit your step goal, celebration when you do
- 📲 **Installable** — add it to your phone's home screen (PWA), works offline

## Run it locally
```bash
cd ~/Desktop/dream
python3 -m http.server 8123
```
Then open **http://localhost:8123** in your browser.

## Put it on your Android phone
This is a **PWA** (Progressive Web App), so you don't need the Play Store:

1. **Host it over HTTPS** (free). Easiest options:
   - **Netlify Drop** — drag the `dream` folder onto https://app.netlify.com/drop
   - **GitHub Pages** — push the folder to a repo, enable Pages
   - **Vercel** — `npx vercel` in the folder
2. Open the resulting `https://…` link in **Chrome on your phone**.
3. Tap the **⋮ menu → "Add to Home screen" / "Install app"**.
4. Dream now has its own icon and opens fullscreen like a normal app.

> HTTPS is required for the step sensor, notifications, and offline mode to work on
> your phone. `localhost` works on a computer but not over your home network to a phone.

## Honest limitations (web version)
- **Auto step-counting** uses the phone's motion sensor and only counts **while Dream
  is open** (web apps can't read the all-day background step counter). Use the manual
  "Add steps" / "Set total" buttons to sync with your phone's real count anytime.
- **Notifications** fire while the app/PWA is open or recently used; the web can't
  reliably push when fully closed.

### Want true background steps + push-when-closed?
Those need a real native app. The good news: this exact web app can be wrapped into an
installable Android **APK** with [Capacitor](https://capacitorjs.com/) — then we swap the
step source to a native Health Connect plugin and use native notifications, **without
rewriting the UI**. Ask and we'll set that up as phase 2.

## 🏆 Friends league / leaderboard (free, for ~5–6 friends)

Compete with friends: earn points each day you hit your step goal and gym, and watch
the live leaderboard. This uses a **free Supabase project** (no credit card). Your
personal data still lives on your device — only your daily score/steps go to the shared
league table.

> **Why not LAN?** A daily challenge needs a shared place to store scores that everyone
> can reach from their own home at any time. LAN only works when you're all on the same
> WiFi at once. A tiny cloud table is free at this scale and works from anywhere.

### One-time setup (~10 min, do this once — friends just need the app + a code)
1. Go to **https://supabase.com** → sign up (free) → **New project** (pick any name/password).
2. Open the **SQL Editor** (left sidebar) → **New query** → paste and **Run** this:

   ```sql
   create table public.daily_stats (
     player_id   text not null,
     date        date not null,
     league_code text not null,
     name        text,
     steps       int  default 0,
     step_goal   int  default 8000,
     goal_hit    boolean default false,
     gym_done    boolean default false,
     points      int  default 0,
     updated_at  timestamptz default now(),
     primary key (player_id, date)
   );
   create index daily_stats_league_idx on public.daily_stats (league_code);

   -- Casual friends app: allow the public anon key to read/write this table.
   alter table public.daily_stats enable row level security;
   create policy "friends_open" on public.daily_stats
     for all using (true) with check (true);

   -- Live updates for the leaderboard
   alter publication supabase_realtime add table public.daily_stats;
   ```
3. Go to **Project Settings → API** (or **Data API**). Copy:
   - **Project URL** (e.g. `https://abcdxyz.supabase.co`)
   - **anon public** key (a long string)
4. Paste both into **`supabase-config.js`** (replace the `YOUR_…` placeholders) and save.
5. Reload Dream → **League** tab → create a league → share the **code** with friends.

### How friends join
Each friend installs the **same** deployed app (same URL), opens the **League** tab,
taps **Join**, enters their name + your **league code**. That's it — no account, no signup.

### Scoring — set by the clan leader 👑
Whoever **creates** the league is the **clan leader**. In the League tab they get a
**Clan Rules** editor where they set:
- the **league step goal** and how many **points** hitting it is worth, and
- a list of **daily tasks** (e.g. "Go to the gym", "Run 5 km"), each with its own points.

Members see those rules and a **"Today's Challenges"** checklist they tick off. Everyone's
points are computed from the leader's rules, so when the leader changes them, scores
recompute for everyone. The board also shows each player's goal-hit **streak** 🔥 and a 👑 on the leader.

### Required extra setup (run once, after the first SQL)
This rules feature needs one more migration. In the Supabase **SQL Editor**, run:

```sql
-- Clan rules, set by the league creator
create table if not exists public.leagues (
  league_code text primary key,
  name        text,
  leader_id   text not null,
  rules       jsonb not null default '{}'::jsonb,
  updated_at  timestamptz default now()
);
alter table public.leagues enable row level security;
create policy "leagues_open" on public.leagues for all using (true) with check (true);
alter publication supabase_realtime add table public.leagues;

-- Track which league tasks each member completed per day
alter table public.daily_stats add column if not exists tasks_done jsonb default '[]'::jsonb;
```

> **Security note:** with the open policy above, anyone who has your anon key + league
> code could write to the table. For a private friends group that's fine. If you ever want
> it locked down, we can add Supabase Auth later.

## Data
Your personal history lives in your browser's `localStorage` under the key `dream.v1`
(clearing site data or "Reset all data" wipes it). Only your **daily league stats**
(name, steps, goal-hit, points) are sent to Supabase when you're in a league.
