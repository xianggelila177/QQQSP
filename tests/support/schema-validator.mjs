// Test-only standards validator: Ajv when installed, Python jsonschema otherwise.
// Neither implementation is part of the production server or its dependencies.
import {spawnSync} from 'node:child_process';
let Ajv;
try { Ajv = (await import('ajv/dist/2020.js')).default; }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
export default class SchemaValidator {
  constructor(options = {}) { this.ajv = Ajv ? new Ajv(options) : null; }
  compile(schema) {
    if (this.ajv) return this.ajv.compile(schema);
    const script = 'import json,sys; from jsonschema import Draft202012Validator; x=json.load(sys.stdin); Draft202012Validator.check_schema(x["schema"]); print(json.dumps([{"message":e.message,"instancePath":"/"+"/".join(map(str,e.path))} for e in Draft202012Validator(x["schema"]).iter_errors(x["data"])]))';
    function validate(data) {
      const result = spawnSync('python3', ['-c', script], {input:JSON.stringify({schema,data}),encoding:'utf8',timeout:10000,maxBuffer:4*1024*1024});
      if (result.status !== 0 || result.error) throw new Error('Install npm dev dependencies (Ajv), or Python jsonschema for offline tests: '+(result.stderr || result.error));
      validate.errors = JSON.parse(result.stdout);
      return validate.errors.length === 0;
    }
    return validate;
  }
}
