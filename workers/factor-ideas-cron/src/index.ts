export interface Env {
  GITHUB_REPO: string;
  GITHUB_WORKFLOW_FILE: string;
  VAULT_ADDR: string;
  VAULT_GITHUB_PATH: string;
  MAX_IDEAS: string;
  KERNEL_MODE: string;
  VAULT_TOKEN: string;
}

interface VaultKvResponse {
  data?: {
    data?: {
      GITHUB_PAT?: string;
    };
  };
  errors?: string[];
}

async function readGithubPat(env: Env): Promise<string> {
  const url = `${env.VAULT_ADDR.replace(/\/$/, "")}/v1/kv/data/${env.VAULT_GITHUB_PATH.replace(/^\/+/, "")}`;
  const response = await fetch(url, {
    headers: {
      "X-Vault-Token": env.VAULT_TOKEN,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Vault read failed (${response.status}): ${body.slice(0, 300)}`);
  }

  const payload = (await response.json()) as VaultKvResponse;
  const token = payload.data?.data?.GITHUB_PAT;
  if (!token) {
    throw new Error("Vault secret missing key GITHUB_PAT at kv/github/quant-factors");
  }
  return token;
}

async function dispatchFactorIdeasWorkflow(env: Env, githubPat: string): Promise<Response> {
  const [owner, repo] = env.GITHUB_REPO.split("/");
  if (!owner || !repo) {
    throw new Error(`Invalid GITHUB_REPO: ${env.GITHUB_REPO}`);
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${env.GITHUB_WORKFLOW_FILE}/dispatches`;
  return fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubPat}`,
      "Content-Type": "application/json",
      "User-Agent": "quant-factors-factor-ideas-cron",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify({
      ref: "main",
      inputs: {
        max_ideas: env.MAX_IDEAS,
        mode: env.KERNEL_MODE,
      },
    }),
  });
}

async function runScheduledJob(
  env: Env,
): Promise<
  | { ok: true; repo: string; workflow: string; inputs: { max_ideas: string; mode: string } }
  | { ok: false; error: string }
> {
  try {
    const githubPat = await readGithubPat(env);
    const dispatch = await dispatchFactorIdeasWorkflow(env, githubPat);

    if (dispatch.status === 204) {
      return {
        ok: true,
        repo: env.GITHUB_REPO,
        workflow: env.GITHUB_WORKFLOW_FILE,
        inputs: {
          max_ideas: env.MAX_IDEAS,
          mode: env.KERNEL_MODE,
        },
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
