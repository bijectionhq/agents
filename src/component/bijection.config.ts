import { defineComponent } from "bijection/server";

// concave:invariant component-analysis
// One definition determines the component validators and functions; the inherited
// tooling bridge delegates to it and generated bindings follow actual analysis.
const component = defineComponent("agent");
export default component;
