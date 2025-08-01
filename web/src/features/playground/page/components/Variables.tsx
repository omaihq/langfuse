import { Divider } from "@tremor/react";

import { usePlaygroundContext } from "../context";
import { PromptVariableComponent } from "./PromptVariableComponent";

export const Variables = () => {
  const { promptVariables } = usePlaygroundContext();

  const renderNoVariables = () => (
    <div className="text-xs">
      <p className="mb-2">No variables defined.</p>
      <p>
        Use handlebars in your prompts to add a variable:
        &#123;&#123;exampleVariable&#125;&#125;
      </p>
    </div>
  );

  const renderVariables = () => (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {promptVariables
        .slice()
        .sort((a, b) => {
          if (a.isUsed && !b.isUsed) return -1;
          if (!a.isUsed && b.isUsed) return 1;
          return a.name.localeCompare(b.name);
        })
        .map((promptVariable, index) => (
          <div key={promptVariable.name}>
            <PromptVariableComponent promptVariable={promptVariable} />
            {index !== promptVariables.length - 1 && (
              <Divider className="my-2 text-muted-foreground" />
            )}
          </div>
        ))}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {promptVariables.length === 0 ? renderNoVariables() : renderVariables()}
    </div>
  );
};
