export interface Env {
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_FILE: string;
  MAX_VALIDATION_ITEMS: string;
  SAMPLE_START: string;
  JUPYTER_SERVER_KEY: string;
  GITHUB_PAT: string;
}

function readGithubPat(env: Env): string {
  const token = env.GITHUB_PAT?.trim();
  if (!token) {
    throw new Error("GITHUB_PAT 未配置，请设置 Worker Secret");
  }
  return token;
}

async function dispatchValidationD1Workflow(
  env: Env,
  githubPat: string,
): Promise<Response> {
  const [owner, repo] = env.GITHUB_REPO.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPO: ${env.GITHUB_REPO}`);
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;
  const inputs: Record<string, string> = {
    max_items: env.MAX_VALIDATION_ITEMS,
    sample_start: env.SAMPLE_START,
  };
  const jupyterKey = env.JUPYTER_SERVER_KEY?.trim();
  if (jupyterKey) {
    inputs.jupyter_server_key = jupyterKey;
  }

  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubPat}`,
      "Content-Type": "application/json",
      "User-Agent": "quant-factors-factor-validation-d1-cron",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs,
    }),
  });
}

async function runScheduledJob(
  env: Env,
): Promise<
  | {
      ok: true;
      repo: string;
      workflow: string;
      inputs: Record<string, string>;
    }
  | { ok: false; error: string }
> {
  try {
    const githubPat = readGithubPat(env);
    const dispatch = await dispatchValidationD1Workflow(env, githubPat);

    if (dispatch.status === 204) {
      const inputs: Record<string, string> = {
        max_items: env.MAX_VALIDATION_ITEMS,
        sample_start: env.SAMPLE_START,
      };
      const jupyterKey = env.JUPYTER_SERVER_KEY?.trim();
      if (jupyterKey) {
        inputs.jupyter_server_key = jupyterKey;
      }
      return {
        ok: true,
        repo: env.GITHUB_REPO,
        workflow: env.GITHUB_WORKFLOW_FILE,
        inputs,
      };
    }

    const body = await dispatch.text();
    return {
      ok: false,
      error: `GitHub dispatch ${dispatch.status}: ${body.slice(0, 500)}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const result = await runScheduledJob(env);
    if (!result.ok) {
      console.error(result.error);
      throw new Error(result.error);
    }
    console.log(JSON.stringify(result));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return Response.json({ ok: false, error: "method not allowed" }, { status: 405 });
    }

    const result = await runScheduledJob(env);
    if (!result.ok) {
      return Response.json({ ok: false, error: result.error }, { status: 500 });
    }
    return Response.json({ ok: true, ...result });
  },
};
