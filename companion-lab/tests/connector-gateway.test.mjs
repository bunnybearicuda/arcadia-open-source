import assert from "node:assert/strict";
import test from "node:test";
import { connectorGatewayTool } from "../lib/connector-api.ts";

function connector(id, name, description = "") {
  return {
    id,
    name,
    kind: "mcp",
    url: `https://${id}.example.com/mcp`,
    auth_header: "",
    auth_value: "",
    description,
    enabled: 1,
    allowed_tools: "",
  };
}

test("offers no gateway when nothing is connected", () => {
  assert.equal(connectorGatewayTool([]), null);
});

test("lists every connected service by name so a companion can ask for one", () => {
  const gateway = connectorGatewayTool([
    connector("linear", "Linear", "Task tracking"),
    connector("notes", "Notes"),
  ]);
  assert.equal(gateway.name, "open_connector");
  assert.match(gateway.description, /Linear \(Task tracking\)/);
  assert.match(gateway.description, /Notes/);
});

test("constrains the connector argument to real services", () => {
  const gateway = connectorGatewayTool([connector("linear", "Linear")]);
  const property = gateway.parameters.properties.connector;
  assert.deepEqual(property.enum, ["Linear"]);
  assert.deepEqual(gateway.parameters.required, ["connector"]);
  // A closed schema keeps models from inventing extra arguments.
  assert.equal(gateway.parameters.additionalProperties, false);
});

test("the gateway alone is the only tool exposed before a service is opened", () => {
  // The point of on-demand loading: one small tool, not every service's tools.
  const gateway = connectorGatewayTool([
    connector("a", "A"),
    connector("b", "B"),
    connector("c", "C"),
  ]);
  assert.equal(Object.keys(gateway.parameters.properties).length, 1);
});
