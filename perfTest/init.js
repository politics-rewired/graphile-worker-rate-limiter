const { Pool } = require("pg");

const pgPool = new Pool({ connectionString: process.env.PERF_DATABASE_URL });

const jobCount = parseInt(process.argv[2], 10) || 1;

async function main() {
  await pgPool.query(
    `
    do $$
    begin
      perform graphile_worker.add_job(
        'log_if_999',
        json_build_object('id', i),
        flags =>
          (case
            when i < 5000 then ARRAY['bucket:a']
            when i < 10000 then ARRAY['bucket:b']
            when i < 15000 then ARRAY['bucket:c']
            when i < 20000 then ARRAY['bucket:d']
            when i < 25000 then ARRAY['bucket:e']
            when i < 30000 then ARRAY['bucket:f']
            when i < 35000 then ARRAY['bucket:g']
            else ARRAY['bucket:h']
          end)
      ) from generate_series(1, ${jobCount}) i;
    end;
    $$ language plpgsql;
  `,
  );

  pgPool.end();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
