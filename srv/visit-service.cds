/** Internal, queued: turns zone events into SiteVisits on A4H. Not exposed over HTTP. */
@protocol: 'none'
service VisitService {
  event createVisit : { eventKey : String; device : String(40); zone_ID : UUID; zoneName : String(60); at : Timestamp; }
  event closeVisit  : { eventKey : String; enterEventKey : String; device : String(40); zone_ID : UUID; zoneName : String(60); at : Timestamp; }
}
