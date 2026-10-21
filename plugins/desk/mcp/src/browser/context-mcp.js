// Browser-only SDK frontend. The normal-root launcher supplies the controller;
// this mirrored module never imports the Desk server, index or native installer.
import {Server} from "@modelcontextprotocol/sdk/server/index.js"
import {StdioServerTransport} from "@modelcontextprotocol/sdk/server/stdio.js"
import {ListToolsRequestSchema, CallToolRequestSchema} from "@modelcontextprotocol/sdk/types.js"

export async function startContextMcpServer({tools,controller,stdin,stdout,transport}) {
  const server = new Server({name:"desk-web",version:"1.0.0"},{capabilities:{tools:{}}})
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools}))
  server.setRequestHandler(CallToolRequestSchema,async request=>{
    const {name,arguments:input} = request.params
    let result
    if (name === "browser_context") result = await controller.context(input)
    else if (name === "browser_command") result = await controller.command(input)
    else result = {exitCode:1,payload:{isError:true,code:"unknown_tool",message:"Unknown explicit-context browser tool"}}
    return {content:[{type:"text",text:JSON.stringify(result.payload)}],isError:result.exitCode !== 0}
  })
  await server.connect(transport ?? new StdioServerTransport(stdin,stdout))
  return server
}
