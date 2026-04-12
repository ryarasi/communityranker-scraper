export interface MeetupGroup {
  name: string;
  url: string;
  members: number;
  description: string;
}

// TODO: Implement Meetup GraphQL API integration
export async function discoverMeetupGroups(
  _topic: string
): Promise<MeetupGroup[]> {
  return [];
}
