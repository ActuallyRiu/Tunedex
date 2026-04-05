# Tunedex

Real-time music news aggregator with artist intelligence and heat scoring.

## Structure

```
tunedex/
├── pipeline/
│   ├─"�� schema.sql          # Original Supabase schema (6 tables)
│   ├── rss_poller.py       # RSS ingestion pipeline (90s cycle)
│   └─"�� requirements.txt    # Python dependencies
├── scoring/
│   ├── schema_v2.sql       # Heat scoring schema extension
│   ├── heat_scorer.py       # Career-stage-adjusted scoring worker
│   └── rss_poller_v2.py    # Extended poller (AFINN + Reddit + Wikipedia)
└── app/
    └── api/
        └── artists/
            └── heat/
                └── route.ts  # Next.js API route
```

## Setup

1. Run `pipeline/schema.sql` in Supabase SQL editor
2. Run `scoring/schema_v2.sql` in Supabase SQL editor
3. Deploy `pipeline/rss_poller.py` to Railway (always-on)
4. Deploy `scoring/heat_scorer.py` to Railway (cron: `*/15 * * * *`)
5. Deploy Next.js app to Vercel

## Stack

- **Frontend**: Next.js 14, Tailwind, Supabase Realtime
- **Pipeline**: Python, feedparser, AFINN, PRAW (Reddit)
- **Scoring**: Career-stage-adjusted 6-pillar heat score (max 110)
- **Database**: Supabase (Postgres)
- **Queue**: Upstash Redis
- **Hosting**: Vercel (frontend) + Railway (workers)$