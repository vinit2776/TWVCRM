import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { rescheduleReminderEvent } from "@/lib/google-calendar";
import type { ActivityType } from "@/types";

/**
 * POST /api/admin/backfill-followup-timezone
 *
 * One-shot, hand-triggered correction for the follow_up_date timezone bug
 * fixed in PR #256 (istLocalToUtcIso). Every row here was captured as a
 * snapshot on 2026-07-20 — pending, future follow-ups whose stored value
 * still reflects the pre-fix bug (naive IST wall-clock time stored as if
 * it were already UTC, i.e. 5:30 too late).
 *
 * Idempotent by construction: each row is only touched if its CURRENT
 * follow_up_date still exactly matches the wrong value captured in the
 * snapshot below. Re-running this after a successful first run is a no-op
 * (every row will already have moved off its snapshot value). Not a cron —
 * reuses CRON_SECRET purely as an existing, already-deployed shared secret
 * for authenticating this one manual trigger.
 *
 * Delete this route once it's been run successfully in production.
 */

interface SnapshotRow {
  id: string;
  wrong_follow_up_date: string;
  calendar_event_id: string | null;
  type: ActivityType;
  subject: string | null;
  follow_up_notes: string | null;
  lead_id: string;
  lead_name: string;
  owner_email: string;
}

const AFFECTED_ROWS: SnapshotRow[] = [
  {
    "id": "5b31113c-d66c-40dc-bf81-eab63f81939b",
    "wrong_follow_up_date": "2026-07-20T12:00:00+00:00",
    "calendar_event_id": "v7hiia7r7g0q35masm5ls4n5fo",
    "type": "call",
    "subject": "need to call later ",
    "follow_up_notes": null,
    "lead_id": "bf57205d-8946-4e9c-9405-2e85b7229272",
    "lead_name": "Subath",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "1321efe7-a882-4ee1-8b30-0ac721b7a0bc",
    "wrong_follow_up_date": "2026-07-20T12:30:00+00:00",
    "calendar_event_id": "p8ua7625urp229ioeikbuplkrg",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "e999dea6-8a76-4223-9abe-b6ba0f79384c",
    "lead_name": "Prathapchinnathambi",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "f831b77d-407c-4c53-9b83-93907a8d44ce",
    "wrong_follow_up_date": "2026-07-20T12:30:00+00:00",
    "calendar_event_id": "igh8ucf6cl9og7a90n5th3attk",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "aa6bdba0-6869-4c8f-98cd-aed27ef34b39",
    "lead_name": "No Name",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "a25062c1-74eb-46a9-886f-06b9c46c7594",
    "wrong_follow_up_date": "2026-07-20T12:30:00+00:00",
    "calendar_event_id": "9p7rho0dhskgtllstllgp2s98c",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "af8f2d75-1c2d-44d0-bf05-849381ae3bc6",
    "lead_name": "No Name",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "c10f2bab-2a0f-4069-bdce-03cf928be449",
    "wrong_follow_up_date": "2026-07-20T12:30:00+00:00",
    "calendar_event_id": "u7japihfkq3kinlmljl2sjdfu8",
    "type": "call",
    "subject": "1seater cabin ",
    "follow_up_notes": null,
    "lead_id": "2745ab21-53ba-4e0b-9823-2a81de4a947e",
    "lead_name": "Praveen Kumar",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "cc8c78cb-7217-4bf6-ba2d-b6bc325b17dd",
    "wrong_follow_up_date": "2026-07-20T13:00:00+00:00",
    "calendar_event_id": "hfjr0e8jjb5vclol38l64jvo8k",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "263e1dde-c137-455e-9dca-a58626bb5a8a",
    "lead_name": "No Name",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "6082dade-454b-46d6-8ac6-dccf1c000632",
    "wrong_follow_up_date": "2026-07-20T14:00:00+00:00",
    "calendar_event_id": "814na2vhfho9lgm34bgv4hi72s",
    "type": "call",
    "subject": "followup ",
    "follow_up_notes": null,
    "lead_id": "37b02e2e-044f-4225-b09d-e808ba2c6240",
    "lead_name": "Iswariya",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "0898fe27-dc43-4ad6-970f-cfe0149a794b",
    "wrong_follow_up_date": "2026-07-20T15:11:00+00:00",
    "calendar_event_id": "sei7o4cui5b93ft0odg06cjv5c",
    "type": "tour",
    "subject": "client visit completed ",
    "follow_up_notes": null,
    "lead_id": "bd6aa283-0f1f-4fa8-bdf1-55a8d872376d",
    "lead_name": "Value spaces ",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "28ebd140-2645-4791-aff2-c439538b8e81",
    "wrong_follow_up_date": "2026-07-20T16:36:00+00:00",
    "calendar_event_id": "8918nv3fbia59e8iurjj0jcp7g",
    "type": "call",
    "subject": "call not responded ",
    "follow_up_notes": null,
    "lead_id": "069b43a4-09c3-41eb-86e0-ab5c508727a0",
    "lead_name": "Jeni Jeni",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "34d4ab57-03a2-4585-a60c-943983cadb4a",
    "wrong_follow_up_date": "2026-07-20T16:42:00+00:00",
    "calendar_event_id": "siv2ucgfuv3mrqog2845eg2s0s",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "1e12658c-3712-4f7e-b1ae-25a7bad6bfe6",
    "lead_name": "Rohithkumar RK",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "04947ad1-ad59-4b09-aff9-5ef190c9cf87",
    "wrong_follow_up_date": "2026-07-20T16:48:00+00:00",
    "calendar_event_id": "29gvjdlr0avnm8hnl4rrttvd7s",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "1a83736c-4906-493f-87cf-da5bd2e287f8",
    "lead_name": "Elephant in the board room",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "72b1e529-7bd5-495a-8e0b-0dbc1652527f",
    "wrong_follow_up_date": "2026-07-20T16:49:00+00:00",
    "calendar_event_id": "us4qldnbk7sj5cjivd2tg50mso",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "5eb5abde-0b85-4032-b6e5-fa9a2ce4e312",
    "lead_name": "Marybernadette pvt ltd",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "4807a14e-818e-43c1-a910-d0bbd452925b",
    "wrong_follow_up_date": "2026-07-20T16:50:00+00:00",
    "calendar_event_id": "3umnipcfjn90kff8hifleateo4",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "c9762125-4384-488c-aa2f-633ad5a26992",
    "lead_name": "Sakthi Das",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "63823258-166b-4566-aee1-7669087ce052",
    "wrong_follow_up_date": "2026-07-20T16:52:00+00:00",
    "calendar_event_id": "eo579gfa0pg5c794d8uru50iic",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "8c63eead-40ab-4db2-9569-13c04459841e",
    "lead_name": "BON KOUTURE",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "506756f1-d84a-451d-8d59-78fd66907e59",
    "wrong_follow_up_date": "2026-07-20T16:53:00+00:00",
    "calendar_event_id": "sllutt9k6lue5jobod67i4pujg",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "8d1e0d4c-d71f-4bbe-94ea-0442065fc3ad",
    "lead_name": "Gokulakannan Gokulakannan",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "793fcb18-3c51-49a4-85d9-7771e596b94f",
    "wrong_follow_up_date": "2026-07-20T17:00:00+00:00",
    "calendar_event_id": "50vahlm22gtum2bt6udq08gv24",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "faf1f7f1-d6fa-4cd0-831c-89af964be3a9",
    "lead_name": "Robingubbi",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "b5ff736d-14bc-4817-8d5e-e593369c25a4",
    "wrong_follow_up_date": "2026-07-20T17:02:00+00:00",
    "calendar_event_id": "4popqr9v09iarc0o7got5f7c98",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "8184ce65-757c-4062-b53c-d3b275860412",
    "lead_name": "megarck",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "9de25797-46ee-464d-b091-960d794dc628",
    "wrong_follow_up_date": "2026-07-20T17:05:00+00:00",
    "calendar_event_id": "p67eqsoi8651v6kauthi1es1tg",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "43eb6853-8e2b-47d6-9fed-cb4cd5e1a91f",
    "lead_name": "Govind Srinivasan",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "fa7e4057-6e4d-4ff9-b620-28b8254451a7",
    "wrong_follow_up_date": "2026-07-21T10:00:00+00:00",
    "calendar_event_id": "jif0qhi58lerg80hl5qm82pa0g",
    "type": "call",
    "subject": "confirmation followup ",
    "follow_up_notes": null,
    "lead_id": "85dd6436-9e3f-45f3-963c-8e3e08ef90dc",
    "lead_name": "wallet finserve private limited",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "9867b110-da6a-4c30-87cb-65dd18ef303f",
    "wrong_follow_up_date": "2026-07-21T10:00:00+00:00",
    "calendar_event_id": "vctmp8rverv0n79fkn3hpj54m8",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "4147e069-07f6-4ad6-9bb6-438694ea18fe",
    "lead_name": "Sabari G",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "f0fd7f52-d9bc-4620-9270-fc00c6a52fad",
    "wrong_follow_up_date": "2026-07-21T10:00:00+00:00",
    "calendar_event_id": "3htaka5iemq3ibmndguqvjd7k0",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "925f19e3-1cfa-4b45-a7e2-2e7fbc431f6f",
    "lead_name": "Shivakumar Venkateswaran",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "e92afa66-93a0-48fa-aba0-8239b065131d",
    "wrong_follow_up_date": "2026-07-21T10:30:00+00:00",
    "calendar_event_id": "0rl15kntne5heh7lb6s3uq5n6k",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "556063da-e577-44ec-9822-605d32b6dcc7",
    "lead_name": "Rajalingam",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "d5b3ed26-f90a-45f5-b869-53654936a28a",
    "wrong_follow_up_date": "2026-07-21T12:00:00+00:00",
    "calendar_event_id": "c566em7q0rt56evlvrkgc2b5es",
    "type": "call",
    "subject": "1seater cabin ",
    "follow_up_notes": null,
    "lead_id": "bf60ea69-bb75-4668-b4e1-113850fcc064",
    "lead_name": "Sumaya Muhsina",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "a5e36c58-dfd5-42c7-acff-5eae382dd465",
    "wrong_follow_up_date": "2026-07-21T13:30:00+00:00",
    "calendar_event_id": "v0mvvog6tkjmo540kc03r5aad0",
    "type": "call",
    "subject": "space confirmation 4seater cabin ",
    "follow_up_notes": null,
    "lead_id": "d9d8b5cb-f57f-4a98-b307-f0ebc230bd8d",
    "lead_name": "velox",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "e8310682-6707-4a10-96a5-0fbd630c7744",
    "wrong_follow_up_date": "2026-07-22T00:00:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": "aggregator ",
    "follow_up_notes": null,
    "lead_id": "cf68f6fc-0445-4f94-8f41-386f3121f737",
    "lead_name": "Pathfinders",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "cca44cab-12ce-4fe3-a4fb-0bcbffca9a3b",
    "wrong_follow_up_date": "2026-07-22T00:00:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "d2d0138e-5872-411a-b4eb-5fa834ff06a7",
    "lead_name": "Sam",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "45c9c5c7-398a-40d9-a611-8ad32e8924af",
    "wrong_follow_up_date": "2026-07-23T15:59:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "8b7f94b1-802d-4877-be17-b71a06e259e5",
    "lead_name": "M Jayamani",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "41a045df-8d9a-4a86-8751-17e39974ee55",
    "wrong_follow_up_date": "2026-08-11T00:00:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": "looking for conference room ",
    "follow_up_notes": null,
    "lead_id": "260f6597-73b2-4528-aa2d-f270122474b4",
    "lead_name": "Harisudhan R",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "afc7a693-5a6d-439a-a3fc-186042f24066",
    "wrong_follow_up_date": "2026-09-01T00:00:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": "call on September month ",
    "follow_up_notes": null,
    "lead_id": "8522e549-b81a-4d96-bdb8-9f6203e853fa",
    "lead_name": "pavan v",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "0863199f-6b3e-4350-8488-6a1bf00bff2f",
    "wrong_follow_up_date": "2026-09-17T00:00:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": "not looking for now ",
    "follow_up_notes": null,
    "lead_id": "f0d40d0a-06bf-4097-ae15-869ed7cebf0e",
    "lead_name": "Syed",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "2e7a37ce-449e-4335-852b-5aac756fed93",
    "wrong_follow_up_date": "2026-09-30T00:00:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": "call back in September month ",
    "follow_up_notes": null,
    "lead_id": "12e99bea-ff24-440c-a1a8-e213b8eb0d29",
    "lead_name": "Das D",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "cb1cf54e-d1ac-4e9a-b225-6bc171cbb76b",
    "wrong_follow_up_date": "2026-10-02T00:00:00+00:00",
    "calendar_event_id": null,
    "type": "call",
    "subject": "They have hold the plan till sep end ",
    "follow_up_notes": "Followup",
    "lead_id": "1561b0ae-803a-4e88-bbf4-0cf16ecd1673",
    "lead_name": "Poovarasan Selvaraj",
    "owner_email": "sales@theworkvilla.com"
  },
  {
    "id": "9826aa30-2b2e-4013-8326-56ce7769f6f1",
    "wrong_follow_up_date": "2026-10-17T18:14:00+00:00",
    "calendar_event_id": "fbfqmj10l0prjg4tiee1ogn730",
    "type": "call",
    "subject": null,
    "follow_up_notes": null,
    "lead_id": "7af4339c-d0e9-408a-ba96-56c5bf16a443",
    "lead_name": "Swaminathanvarman",
    "owner_email": "sales@theworkvilla.com"
  }
];

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();

  const results = {
    corrected: [] as string[],
    calendarPatched: [] as string[],
    calendarFailed: [] as string[],
    skippedAlreadyCorrected: [] as string[],
    errors: [] as { id: string; error: string }[],
  };

  for (const row of AFFECTED_ROWS) {
    // Idempotency guard: only touch rows still holding the exact wrong value
    // captured in the snapshot. Anything else means it was already fixed
    // (a prior run of this route, or a manual reschedule) — skip.
    const { data: current, error: fetchErr } = await supabase
      .from("activities")
      .select("follow_up_date")
      .eq("id", row.id)
      .single();

    if (fetchErr || !current) {
      results.errors.push({ id: row.id, error: fetchErr?.message ?? "row not found" });
      continue;
    }

    const currentIso = new Date(current.follow_up_date).toISOString();
    const snapshotIso = new Date(row.wrong_follow_up_date).toISOString();
    if (currentIso !== snapshotIso) {
      results.skippedAlreadyCorrected.push(row.id);
      continue;
    }

    const correctedDate = new Date(new Date(row.wrong_follow_up_date).getTime() - IST_OFFSET_MS);
    const correctedIso = correctedDate.toISOString();

    const { error: updateErr } = await supabase
      .from("activities")
      .update({ follow_up_date: correctedIso })
      .eq("id", row.id);

    if (updateErr) {
      results.errors.push({ id: row.id, error: updateErr.message });
      continue;
    }
    results.corrected.push(row.id);

    if (row.calendar_event_id) {
      const newEventId = await rescheduleReminderEvent({
        activityId: row.id,
        leadId: row.lead_id,
        leadName: row.lead_name,
        activityType: row.type,
        subject: row.subject,
        followUpDate: correctedIso,
        followUpNotes: row.follow_up_notes,
        ownerEmail: row.owner_email,
        calendarEventId: row.calendar_event_id,
      });
      if (newEventId) {
        results.calendarPatched.push(row.id);
        if (newEventId !== row.calendar_event_id) {
          await supabase.from("activities").update({ calendar_event_id: newEventId }).eq("id", row.id);
        }
      } else {
        results.calendarFailed.push(row.id);
      }
    }
  }

  await supabase.from("audit_trail").insert({
    entity_type: "activity",
    entity_id: "00000000-0000-0000-0000-000000000000",
    action: "update",
    changes: {
      bulk_timezone_backfill: {
        old: `${results.corrected.length + results.skippedAlreadyCorrected.length} rows with pre-fix follow_up_date`,
        new: `${results.corrected.length} corrected, ${results.calendarPatched.length} calendar events moved`,
      },
    },
  });

  return NextResponse.json({
    total: AFFECTED_ROWS.length,
    corrected: results.corrected.length,
    calendarPatched: results.calendarPatched.length,
    calendarFailed: results.calendarFailed.length,
    skippedAlreadyCorrected: results.skippedAlreadyCorrected.length,
    errors: results.errors,
  });
}
