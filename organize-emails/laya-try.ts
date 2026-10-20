// scratch: try Laya's systemone API. usage: node organize-emails/laya-try.ts
import ollama from "ollama";

const response = await (ollama as any).systemone({
  model: "laya:421m-typed-decisions-bf16",
  state: "From: HDFC Bank\nSubject: Your credit card payment is due in 2 days\n\nMinimum due Rs 4,200 must be paid by Oct 22.",
  questions: {
    says_hello: {
      type: "noul",
      instructions: "Does the state text contain a greeting?",
      criteria: {
        true: "The state text contains a greeting.",
        false: "The state text does not contain a greeting.",
      },
    },
    needs_attention: {
      type: "noul",
      instructions: "Does this email need the reader to act or know something time-sensitive?",
      criteria: {
        true: "The email requires action or is time-sensitive.",
        false: "The email is a newsletter, promotion or informational only.",
      },
    },
  },
});

console.log(JSON.stringify(response, null, 2));
