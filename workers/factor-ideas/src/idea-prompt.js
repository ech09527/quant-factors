import templateText from "../assets/generate-ideas-worker.txt";
import outputSpecText from "../assets/idea-output-spec.txt";
import factorSqlRulesText from "../assets/idea-factor-sql-rules.txt";

export function formatOperators(operators) {
  if (!operators?.length) {
    return "";
  }
  return operators
    .map((op) => {
      const lines = [`- **${op.name}** \`${op.signature}\``, `  - ${op.description}`];
      if (op.example) {
        lines.push(`  - 示例: \`${op.example}\``);
      }
      return lines.join("\n");
    })
    .join("\n");
}

export function formatSaturatedPatterns(patterns) {
  if (!patterns?.length) {
    return "";
  }
  return patterns.map((p) => `- (${p.count}×) \`${p.expr_canonical}\``).join("\n");
}

function buildCustomOpsSection(activeOperators) {
  const body = formatOperators(activeOperators);
  if (!body) {
    return "";
  }
  return `## 已注册自定义算子\n\n${body}\n`;
}

function buildSaturatedSection(saturatedPatterns) {
  const body = formatSaturatedPatterns(saturatedPatterns);
  if (!body) {
    return "";
  }
  return `## 饱和表达式（请避开雷同结构）\n\n${body}\n`;
}

export function buildIdeaGenerationPrompt(options) {
  const {
    datasetSection,
    activeOperators = [],
    saturatedPatterns = [],
    maxIdeas = 3,
    template = templateText,
    outputSpec = outputSpecText,
    factorSqlRules = factorSqlRulesText,
  } = options;
  const minIdeas = Math.max(1, maxIdeas);
  const maxBatch = Math.max(minIdeas, Math.min(5, maxIdeas + 2));

  return template
    .replace("{{OUTPUT_SPEC}}", outputSpec.trim())
    .replace("{{FACTOR_SQL_RULES}}", factorSqlRules.trim())
    .replace("{{CUSTOM_OPS_SECTION}}", buildCustomOpsSection(activeOperators))
    .replace("{{SATURATED_SECTION}}", buildSaturatedSection(saturatedPatterns))
    .replace("{{MIN_IDEAS}}", String(minIdeas))
    .replace("{{MAX_BATCH}}", String(maxBatch))
    .replace("{{DATASETS_SECTION}}", datasetSection?.trim() ?? "");
}
