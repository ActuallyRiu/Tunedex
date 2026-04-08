/**
 * app/api/artists/heat/route.ts
 *
 * Next.js 14 App Router API route.
 * Returns artist heat scores for the frontend feed.
 *
 * Endpoints:
 *   GET /api/artists/heat              Ã¢ÂÂ leaderboard (top N by heat score)
 *   GET /api/artists/heat?id=<uuid>    Ã¢ÂÂ single artist full breakdown
 *   GET /api/artists/heat?stage=emerging Ã¢ÂÂ filter by career stage
 *
 * Uses Supabase anon key (public read via RLS).
 * Cached at edge for 60 seconds.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

type CareerStage = "emerging" | "rising" | "breaking" | "established";

interface ArtistHeatRow {
  id: string; name: string; career_stage: CareerStage; heat_score: number;
  heat_label: string; controversy_flag: boolean; last_scored_at: string;
  streaming_score: number|null; brand_base_score: number|null;
  brand_multiplier: number|null; sentiment_score: number|null;
  afinn_avg: number|null; is_controversy: boolean|null;
  radio_score: number|null; press_score: number|null;
}

function getDb() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error("Supabase env vars missing");
  return createClient(url, key);
}

export async function GET(req: NextRequest) {
  const db = getDb();
  const params = req.nextUrl.searchParams;
  const artistId = params.get("id");
  const stage = params.get("stage") as CareerStage|null;
  const limit = Math.min(parseInt(params.get("limit")??"50"),200);
  const offset = parseInt(params.get("offset")??"0");
  if (artistId) {
    if (!/^[0-9a-f-]{36}$/.test(artistId)) return NextResponse.json({error:"Invalid ID"},{status:400});
    const {data:artists,error} = await db.from("artist_latest_signals").select("*").eq("id",artistId).limit(1);
    if (error) return NextResponse.json({error:"DB error"},{status:500});
    if (!artists?.length) return NextResponse.json({error:"Not found"},{status:404});
    const {data:history} = await db.from("artist_heat_history").select("scored_at,final_score,career_stage,streaming_score,brand_score,sentiment_score,radio_score,press_score,bonus_pts,brand_multiplier,heat_label,controversy_active").eq("artist_id",artistId).gte("scored_at",new Date(Date.now()-604800000).toISOString()).order("scored_at",{ascending:true});
    const row = artists[0];
    return NextResponse.json({...row,history_7d:history??[]},{headers:{"Cache-Control":"public, s-maxage=60"}});
  }
  let q = db.from("artist_heat_leaderboard").select("id,name,career_stage,heat_score,heat_label,controversy_flag,last_scored_at,score_delta_7d",{count:"exact"});
  if (stage) q = q.eq("career_stage",stage);
  const {data:lb,error:e2,count} = await q.order("heat_score",{ascending:false}).range(offset,offset+limit-1);
  if (e2) return NextResponse.json({error:"DB error"},{status:500});
  return NextResponse.json({artists:lb??[],total:count??0,stage_filter:stage,generated_at:new Date().toISOString()},{headers:{
   "Cache-Control":"public, s-maxage=60, stale-while-revalidate=30"}});
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.TUNEDEX_ADMIN_SECRET}`) return NextResponse.json({error:"Unauthorised"},{status:401});
  const body = await req.json().catch(()=>null);
  if (!body?.artist_id) return NextResponse.json({error:"artist_id required"},{status:400});
  return NextResponse.json({message:`Rescore queued for ${body.artist_id}`,note:"Scorer runs every 15min."});
}
