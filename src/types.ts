export type EdgeKind = 'IP_CHAIN' | 'IP_DATA' | 'I2P_CHAIN' | 'I2P_DATA' | 'unknown';

export type Direction = 'INBOUND' | 'OUTBOUND' | string;

export type RawPeer = {
  address?: string;
  capabilities?: Array<Record<string, string>>;
  direction?: Direction;
  handshakeStatus?: string;
  nodeId?: string;
  transport?: string;
  version?: string;
};

export type RawNode = {
  chainPeers?: RawPeer[];
  dataPeers?: RawPeer[];
  error?: string;
  info?: {
    buildVersion?: string;
    nodeId?: string;
  };
  label: string;
  name: string;
  publicHost?: string | null;
  role?: string;
  status?: {
    height?: number;
    numberOfConnections?: number;
    numberOfDataConnections?: number;
    syncPhase?: string;
  };
};

export type EdgeSample = {
  address?: string;
  direction?: Direction;
  nodeId?: string;
  reportedBy?: string;
  transport?: string;
  version?: string;
};

export type TopologyNode = {
  chainCount?: number;
  connectedTo?: string[];
  dataCount?: number;
  height?: number;
  host?: string | null;
  id: string;
  kind?: string;
  label: string;
  name?: string;
  nodeIds?: string[];
  observedBy?: string[];
  peerCount?: number;
  role?: string;
  status?: string;
  version?: string;
  versions?: string[];
};

export type TopologyEdge = {
  count: number;
  kind: EdgeKind;
  samples: EdgeSample[];
  source: string;
  target: string;
};

export type TopologyData = {
  edges: TopologyEdge[];
  extraNodes?: Record<string, TopologyNode>;
  graphNodes: Record<string, TopologyNode>;
  namedLabels?: Record<string, string>;
};

export type NetworkSnapshot = {
  errors?: Record<string, string>;
  generatedAt?: string;
  nodes: Record<string, RawNode>;
  topology: TopologyData;
};

export type NodePosition = {
  id: string;
  radius: number;
  x: number;
  y: number;
};

export type EdgeDirection = {
  end: boolean;
  start: boolean;
  unknown: boolean;
};

export type GraphNode = TopologyNode & NodePosition;

export type GraphEdge = TopologyEdge & {
  direction: EdgeDirection;
  id: string;
  line: {
    x1: number;
    x2: number;
    y1: number;
    y2: number;
  };
};

export type GraphModel = {
  edges: GraphEdge[];
  height: number;
  nodes: GraphNode[];
  summaryHeight: number;
  width: number;
};

export type NodeApiFetchResult = {
  body: string;
  contentLength?: number;
  contentType: string;
  data: unknown;
  ok: boolean;
  status: number;
  statusText: string;
};

export type QdnAction =
  | 'FETCH_NODE_API'
  | 'FETCH_QDN_RESOURCE'
  | 'GET_NODE_STATUS'
  | 'IS_USING_PUBLIC_NODE'
  | 'LIST_QDN_RESOURCES'
  | 'SEARCH_QDN_RESOURCES'
  | 'SHOW_ACTIONS'
  | 'WHICH_UI';
