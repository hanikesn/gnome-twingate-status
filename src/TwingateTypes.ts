type ResourceMetadata = {
    ca_data: string;
    resource_type: number;
};
export type Status = 'Online' | 'Offline' | 'Authenticating';

export type User = {
    avatar_url: string;
    email: string;
    first_name: string;
    id: string;
    is_admin: boolean;
    last_name: string;
};

export type Resource = {
    address: string;
    admin_url: string;
    auth_expires_at: number;
    auth_flow_id: string;
    auth_state: 'pending' | 'none';
    can_open_in_browser: boolean;
    client_visibility: 1 | 2;
    global_id: string;
    id: string;
    metadata: ResourceMetadata;
    name: string;
    open_url: string | null;
    type: string;
};
export type ResourceMessage = {
    resources: Resource[];
    admin_url: string;
    full_tunnel_time_limit: number;
    internet_security: {
        mode: number;
        status: number;
    };
    user: User | null;
};
export type AuthRequiredMessage = {
    addr: string;
    alias: string;
    expires_at: number;
    expiring_soon: boolean;
    name: string;
    resource_id: string;
};
export type AuthEndMessage = {
    auth_flow_id: string;
    reason: string;
    state: boolean;
};
type CommandMessage =
    | ({ cmd: 'status' } & StatusMessage)
    | ({ cmd: 'reauth' } & ReAuthMessage)
    | ({ cmd: 'auth-end' } & AuthEndMessage)
    | ({ cmd: 'auth-required' } & AuthRequiredMessage)
    | { cmd: 'resources'; 'content-length': number }
    | { cmd: 'status-end' };
export type Message = CommandMessage | ResourceMessage;
export type ReAuthMessage = {
    url: string;
};
export type StatusMessage = {
    details: string;
    internet_security: number;
    msg: Status;
};
type AuthCmd = {
    cmd: 'auth';
    resource: string;
};
type ResourceCmd = {
    cmd: 'resources';
};

export type Commands = AuthCmd | ResourceCmd;
