import { describe, it, expect, vi, beforeEach } from "vitest"
import {
  formatRequest,
  handleManageTransportRequests,
  handleListAllTransports,
  handleGetTransportForObject,
} from "../src/tools/transports"
import type { TransportRequest } from "abap-adt-api"

vi.mock("../src/connections", () => ({ ensureConnected: vi.fn(), getHeldLock: vi.fn(), trackLock: vi.fn(), forgetLock: vi.fn() }))
import { ensureConnected } from "../src/connections"

const mockClient = {
  username: "BASIS",
  userTransports: vi.fn(),
  transportDetails: vi.fn(),
  createTransport: vi.fn(),
  transportRelease: vi.fn(),
  transportDelete: vi.fn(),
  transportSetOwner: vi.fn(),
  transportInfo: vi.fn(),
  systemUsers: vi.fn(),
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ensureConnected).mockResolvedValue(mockClient as any)
  mockClient.transportDelete.mockResolvedValue(undefined)
})

// ─── formatRequest ────────────────────────────────────────────────────────────

describe("formatRequest", () => {
  it("formats transport fields", () => {
    const r = {
      "tm:number": "CARX000123",
      "tm:status": "D",
      "tm:owner": "BASIS",
      "tm:desc": "My transport",
    } as unknown as TransportRequest
    const text = formatRequest(r)
    expect(text).toContain("CARX000123")
    expect(text).toContain("D")
    expect(text).toContain("BASIS")
    expect(text).toContain("My transport")
  })
})

// ─── manage_transport_requests: list ─────────────────────────────────────────

describe("manage_transport_requests list", () => {
  it("lists open transports", async () => {
    const transport = {
      "tm:number": "CARX000001", "tm:status": "D", "tm:owner": "BASIS", "tm:desc": "Dev transport",
      links: [], objects: [], tasks: []
    } as unknown as TransportRequest

    mockClient.userTransports.mockResolvedValue({
      workbench: [{ modifiable: [transport], released: [] }],
      customizing: []
    })

    const result = await handleManageTransportRequests({ action: "list" })
    expect(result.content[0].text).toContain("CARX000001")
    expect(result.content[0].text).toContain("Open transports")
  })

  it("returns no-transports message when list is empty", async () => {
    mockClient.userTransports.mockResolvedValue({ workbench: [], customizing: [] })
    const result = await handleManageTransportRequests({ action: "list" })
    expect(result.content[0].text).toContain("No open transports")
  })
})

// ─── manage_transport_requests: details ──────────────────────────────────────

describe("manage_transport_requests details", () => {
  const detailTransport = {
    "tm:number": "CARX000010",
    "tm:status": "D",
    "tm:owner": "DEVUSER",
    "tm:desc": "Fix for order report",
    "tm:uri": "/uri/CARX000010",
    links: [],
    objects: [
      { "tm:pgmid": "R3TR", "tm:type": "PROG", "tm:name": "ZPROG_A", "tm:dummy_uri": "", "tm:obj_info": "Program" }
    ],
    tasks: [
      {
        "tm:number": "CARX000011",
        "tm:owner": "DEVUSER",
        "tm:desc": "Task 1",
        "tm:status": "D",
        "tm:uri": "",
        links: [],
        objects: [
          { "tm:pgmid": "R3TR", "tm:type": "CLAS", "tm:name": "ZCL_ORDER", "tm:dummy_uri": "", "tm:obj_info": "Class" }
        ]
      }
    ]
  } as unknown as TransportRequest

  it("shows owner, status, description, and objects", async () => {
    mockClient.transportDetails.mockResolvedValue(detailTransport)
    const result = await handleManageTransportRequests({ action: "details", transportNumber: "CARX000010" })
    const text = result.content[0].text
    expect(text).toContain("CARX000010")
    expect(text).toContain("DEVUSER")
    expect(text).toContain("Fix for order report")
    expect(text).toContain("ZPROG_A")
    expect(text).toContain("ZCL_ORDER")
  })

  it("shows total object count across all tasks", async () => {
    mockClient.transportDetails.mockResolvedValue(detailTransport)
    const result = await handleManageTransportRequests({ action: "details", transportNumber: "CARX000010" })
    expect(result.content[0].text).toContain("Total objects: 2")
  })

  it("returns error when transportNumber is missing", async () => {
    const result = await handleManageTransportRequests({ action: "details" })
    expect(result.content[0].text).toContain("transportNumber required")
  })
})

// ─── manage_transport_requests: create ───────────────────────────────────────

describe("manage_transport_requests create", () => {
  it("creates a transport and returns its number", async () => {
    mockClient.createTransport.mockResolvedValue("CARX000099")
    const result = await handleManageTransportRequests({
      action: "create",
      objectUrl: "/url",
      description: "My fix",
      packageName: "ZDEV",
    })
    expect(result.content[0].text).toContain("CARX000099")
    expect(result.content[0].text).toContain("My fix")
    expect(result.content[0].text).toContain("ZDEV")
  })

  it("returns error when required fields are missing", async () => {
    const result = await handleManageTransportRequests({ action: "create" })
    expect(result.content[0].text).toContain("required")
    expect(mockClient.createTransport).not.toHaveBeenCalled()
  })
})

// ─── manage_transport_requests: release ──────────────────────────────────────

describe("manage_transport_requests release", () => {
  it("reports success when all checks pass", async () => {
    mockClient.transportRelease.mockResolvedValue([{
      "chkrun:status": "released",
      messages: [{ "chkrun:type": "S", "chkrun:shortText": "Released OK" }]
    }])
    const result = await handleManageTransportRequests({ action: "release", transportNumber: "CARX000001" })
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("Released OK")
  })

  it("reports failure when status is not released", async () => {
    mockClient.transportRelease.mockResolvedValue([{
      "chkrun:status": "abortrelapifail",
      messages: [{ "chkrun:type": "E", "chkrun:shortText": "Objects locked" }]
    }])
    const result = await handleManageTransportRequests({ action: "release", transportNumber: "CARX000001" })
    expect(result.content[0].text).toContain("❌")
    expect(result.content[0].text).toContain("Objects locked")
  })

  it("returns error message when number is missing", async () => {
    const result = await handleManageTransportRequests({ action: "release" })
    expect(result.content[0].text).toContain("transportNumber required")
  })
})

// ─── manage_transport_requests: delete ───────────────────────────────────────

describe("manage_transport_requests delete", () => {
  it("deletes transport and confirms", async () => {
    const result = await handleManageTransportRequests({ action: "delete", transportNumber: "CARX000055" })
    expect(mockClient.transportDelete).toHaveBeenCalledWith("CARX000055")
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("CARX000055")
    expect(result.content[0].text).toContain("deleted")
  })

  it("returns error when transportNumber is missing", async () => {
    const result = await handleManageTransportRequests({ action: "delete" })
    expect(result.content[0].text).toContain("transportNumber required")
    expect(mockClient.transportDelete).not.toHaveBeenCalled()
  })
})

// ─── manage_transport_requests: change_owner ─────────────────────────────────

describe("manage_transport_requests change_owner", () => {
  it("changes owner and confirms", async () => {
    mockClient.transportSetOwner.mockResolvedValue({
      "tm:number": "CARX000055",
      "tm:targetuser": "NEWUSER",
    })
    const result = await handleManageTransportRequests({
      action: "change_owner",
      transportNumber: "CARX000055",
      newOwner: "NEWUSER",
    })
    expect(mockClient.transportSetOwner).toHaveBeenCalledWith("CARX000055", "NEWUSER")
    expect(result.content[0].text).toContain("✅")
    expect(result.content[0].text).toContain("CARX000055")
    expect(result.content[0].text).toContain("NEWUSER")
  })

  it("returns error when required fields are missing", async () => {
    const result = await handleManageTransportRequests({ action: "change_owner", transportNumber: "CARX000055" })
    expect(result.content[0].text).toContain("required")
    expect(mockClient.transportSetOwner).not.toHaveBeenCalled()
  })
})

// ─── list_all_transports ──────────────────────────────────────────────────────

describe("list_all_transports", () => {
  const makeTransport = (num: string, owner: string, desc: string, objects = [] as any[]) => ({
    "tm:number": num, "tm:status": "D", "tm:owner": owner, "tm:desc": desc,
    "tm:uri": "", links: [], objects, tasks: []
  })

  it("aggregates transports across all users", async () => {
    mockClient.systemUsers.mockResolvedValue([
      { id: "BASIS", title: "BASIS" },
      { id: "DEVUSER", title: "Dev User" },
    ])
    mockClient.userTransports
      .mockResolvedValueOnce({
        workbench: [{ modifiable: [makeTransport("CARX000001", "BASIS", "Basis fix")], released: [] }],
        customizing: []
      })
      .mockResolvedValueOnce({
        workbench: [{ modifiable: [makeTransport("CARX000002", "DEVUSER", "Dev work")], released: [] }],
        customizing: []
      })

    const result = await handleListAllTransports({})
    const text = result.content[0].text
    expect(text).toContain("CARX000001")
    expect(text).toContain("CARX000002")
    expect(text).toContain("BASIS")
    expect(text).toContain("DEVUSER")
    expect(text).toContain("2 total")
  })

  it("shows objects inside each transport", async () => {
    mockClient.systemUsers.mockResolvedValue([{ id: "BASIS", title: "BASIS" }])
    mockClient.userTransports.mockResolvedValue({
      workbench: [{
        modifiable: [makeTransport("CARX000010", "BASIS", "With objects", [
          { "tm:pgmid": "R3TR", "tm:type": "PROG", "tm:name": "ZPROG", "tm:dummy_uri": "", "tm:obj_info": "Program" }
        ])],
        released: []
      }],
      customizing: []
    })

    const result = await handleListAllTransports({})
    expect(result.content[0].text).toContain("ZPROG")
    expect(result.content[0].text).toContain("PROG")
  })

  it("returns empty message when no transports exist", async () => {
    mockClient.systemUsers.mockResolvedValue([{ id: "BASIS", title: "BASIS" }])
    mockClient.userTransports.mockResolvedValue({ workbench: [], customizing: [] })

    const result = await handleListAllTransports({})
    expect(result.content[0].text).toContain("No modifiable transports found")
  })

  it("tolerates a failing user query without breaking the result", async () => {
    mockClient.systemUsers.mockResolvedValue([
      { id: "BASIS", title: "BASIS" },
      { id: "BADUSER", title: "Bad User" },
    ])
    mockClient.userTransports
      .mockResolvedValueOnce({
        workbench: [{ modifiable: [makeTransport("CARX000001", "BASIS", "OK transport")], released: [] }],
        customizing: []
      })
      .mockRejectedValueOnce(new Error("authorization failed"))

    const result = await handleListAllTransports({})
    expect(result.content[0].text).toContain("CARX000001")
    expect(result.content[0].text).not.toContain("BADUSER")
  })

  it("shows released transports when status=released", async () => {
    mockClient.systemUsers.mockResolvedValue([{ id: "BASIS", title: "BASIS" }])
    mockClient.userTransports.mockResolvedValue({
      workbench: [{
        modifiable: [],
        released: [makeTransport("CARX000099", "BASIS", "Released transport")]
      }],
      customizing: []
    })

    const result = await handleListAllTransports({ status: "released" })
    expect(result.content[0].text).toContain("CARX000099")
  })
})

// ─── get_transport_for_object ─────────────────────────────────────────────────

describe("get_transport_for_object", () => {
  it("returns transport info fields", async () => {
    mockClient.transportInfo.mockResolvedValue({
      PGMID: "R3TR",
      OBJECT: "PROG",
      OBJECTNAME: "ZPROG",
      DEVCLASS: "ZDEV",
      OPERATION: "I",
      CTEXT: "Workbench request"
    })
    const result = await handleGetTransportForObject({ url: "/url" })
    const text = result.content[0].text
    expect(text).toContain("R3TR")
    expect(text).toContain("ZPROG")
    expect(text).toContain("ZDEV")
    expect(text).toContain("Workbench request")
  })
})
